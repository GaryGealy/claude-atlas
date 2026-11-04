import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { ClaudePaths } from './paths.js';
import type { Item, Source } from './model.js';
import { readText } from './util/fs.js';
import { parseFrontmatter } from './util/frontmatter.js';
import { readPluginDir } from './scan/plugins.js';
import { mcpItemsFrom } from './scan/mcp.js';

export type CandidateInput =
  | { kind: 'path'; path: string }
  | { kind: 'git'; url: string }
  | { kind: 'marketplace'; marketplace: string; plugin: string };
export type GitRunner = (args: string[]) => Promise<void>;

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err) => (err ? reject(err) : resolve()));
  });
}

async function stat(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const within = (root: string, abs: string): boolean => abs === root || abs.startsWith(root + path.sep);

/** Names of zip entries stored as symlinks (unix mode in the central directory's external attributes). */
function zipSymlinks(buf: Uint8Array): Set<string> {
  const out = new Set<string>();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  let off = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let n = 0; n < count && off + 46 <= buf.length && dv.getUint32(off, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const madeBy = dv.getUint16(off + 4, true) >> 8;
    const mode = dv.getUint32(off + 38, true) >>> 16;
    if (madeBy === 3 && (mode & 0o170000) === 0o120000) {
      out.add(new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen)));
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function extractZip(zipFile: string, target: string): Promise<string> {
  const buf = new Uint8Array(await fs.readFile(zipFile));
  const links = zipSymlinks(buf);
  let entries = 0;
  let total = 0;
  let files: ReturnType<typeof unzipSync>;
  try {
    files = unzipSync(buf, {
    filter(f) {
      if (++entries > MAX_ZIP_ENTRIES) throw new Error(`Zip has too many entries (limit ${MAX_ZIP_ENTRIES})`);
      total += f.originalSize;
      if (total > MAX_ZIP_BYTES) throw new Error(`Zip is too large uncompressed (limit ${MAX_ZIP_BYTES} bytes)`);
      return !links.has(f.name) && !f.name.startsWith('__MACOSX/');
    },
    });
  } catch (e) {
    const m = (e as Error).message;
    throw new Error(/too (many|large)/.test(m) ? m : `Not a valid zip file: ${zipFile} (${m})`);
  }
  const root = path.resolve(target);
  let actual = 0;
  const planned: [string, Uint8Array][] = [];
  for (const [rawName, data] of Object.entries(files)) {
    const name = rawName.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`Zip entry has an absolute path: ${rawName}`);
    const abs = path.resolve(root, name);
    if (abs === root || !within(root, abs)) throw new Error(`Zip entry escapes the target directory: ${rawName}`);
    actual += data.length;
    if (actual > MAX_ZIP_BYTES) throw new Error(`Zip is too large uncompressed (limit ${MAX_ZIP_BYTES} bytes)`);
    planned.push([abs, data]);
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  for (const [abs, data] of planned) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }
  const top = await fs.readdir(root, { withFileTypes: true });
  return top.length === 1 && top[0].isDirectory() ? path.join(root, top[0].name) : root;
}

function validateGitUrl(url: string): void {
  if (url.startsWith('-') || /\s/.test(url) || !/^(https:\/\/|ssh:\/\/|file:\/\/|git@[^\s:]+:)/.test(url)) {
    throw new Error(`Unsupported git URL (use https://, ssh://, git@host:path or file://): ${url}`);
  }
}

/** Removes symlinks in an untrusted clone whose real target lies outside the clone, so no reader can follow them. */
async function sanitizeClone(root: string): Promise<void> {
  const real = await fs.realpath(root);
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = await fs.realpath(full);
        } catch {
          /* dangling or looping */
        }
        if (!target || !within(real, target)) await fs.rm(full, { force: true });
      } else if (e.isDirectory()) await walk(full);
    }
  };
  await walk(real);
}

async function cloneInto(url: string, p: ClaudePaths, git: GitRunner, identity: string): Promise<string> {
  validateGitUrl(url);
  const dir = path.join(p.cacheDir, 'candidates', sha(identity));
  if (!(await stat(dir))) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await git(['clone', '--depth', '1', url, dir]);
    if (!(await stat(dir))) throw new Error(`git clone did not produce ${dir}`);
  }
  await sanitizeClone(dir);
  return dir;
}

async function realWithin(root: string, target: string): Promise<boolean> {
  try {
    return within(await fs.realpath(root), await fs.realpath(target));
  } catch {
    return false;
  }
}

const repoBase = (url: string): string => path.basename(url.replace(/\/+$/, '').replace(/\.git$/, '').replace(/:/g, '/')) || 'candidate';

function pluginSource(name: string): Source {
  return { id: `candidate:${name}`, kind: 'candidate', label: `Candidate: ${name}`, enabled: true, decidedBy: null };
}

function finish(sourceId: string, items: Item[]): Item[] {
  return items.map((i) => ({ ...i, sourceId, ghost: true, enabled: true, decidedBy: null }));
}

async function loadDir(root: string, fallbackName: string): Promise<{ sources: Source[]; items: Item[] }> {
  const warnings: string[] = [];
  const manifest = await readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const hasManifest = (await stat(path.join(root, '.claude-plugin', 'plugin.json'))) !== null;
  const hasSkillMd = (await stat(path.join(root, 'SKILL.md'))) !== null;
  const hasSkillsDir = (await stat(path.join(root, 'skills')))?.isDirectory() === true;

  if (hasManifest || (!hasSkillMd && hasSkillsDir)) {
    const mName = isObj(manifest) && typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : '';
    const name = mName || fallbackName;
    const sourceId = `candidate:${name}`;
    const { items, pluginMcp } = await readPluginDir(root, sourceId, name, (m) => warnings.push(m));
    const mcp = pluginMcp.flatMap((j) => mcpItemsFrom(sourceId, j, ''));
    return { sources: [pluginSource(name)], items: finish(sourceId, [...items, ...mcp]) };
  }
  if (hasSkillMd) return loadLoneSkill(path.join(root, 'SKILL.md'));
  throw new Error(`No skill or plugin found in ${root}`);
}

async function loadLoneSkill(file: string): Promise<{ sources: Source[]; items: Item[] }> {
  const text = await readText(file);
  if (text === null) throw new Error(`No skill found in ${file}`);
  const fm = parseFrontmatter(text);
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const name = str(fm.data.name) || path.basename(path.dirname(file));
  const item: Item = { id: `skill:candidate:${name}:${name}`, kind: 'skill', name, fullName: name, sourceId: `candidate:${name}`, path: file, description: str(fm.data.description), enabled: true, decidedBy: null };
  return { sources: [pluginSource(name)], items: finish(`candidate:${name}`, [item]) };
}

async function loadMarketplace(input: { marketplace: string; plugin: string }, p: ClaudePaths, git: GitRunner) {
  const known = await readJson(path.join(p.claudeDir, 'plugins', 'known_marketplaces.json'));
  const entry = isObj(known) ? known[input.marketplace] : undefined;
  if (!isObj(entry)) throw new Error(`Unknown marketplace: ${input.marketplace}`);

  let mktRoot: string | null = null;
  if (typeof entry.installLocation === 'string' && (await stat(entry.installLocation))?.isDirectory()) mktRoot = path.resolve(entry.installLocation);
  if (!mktRoot) {
    const src = isObj(entry.source) ? entry.source : {};
    const url =
      src.source === 'github' && typeof src.repo === 'string'
        ? `https://github.com/${src.repo}.git`
        : typeof src.url === 'string'
          ? src.url
          : null;
    if (!url) throw new Error(`Marketplace ${input.marketplace} has no installLocation or repository to clone`);
    mktRoot = await cloneInto(url, p, git, url);
  }

  const mj = await readJson(path.join(mktRoot, '.claude-plugin', 'marketplace.json'));
  const plugins = isObj(mj) && Array.isArray(mj.plugins) ? mj.plugins : [];
  const pl = plugins.find((x) => isObj(x) && x.name === input.plugin);
  if (!isObj(pl)) throw new Error(`Plugin ${input.plugin} not found in marketplace ${input.marketplace}`);

  const src = pl.source;
  let root: string;
  if (typeof src === 'string') {
    root = path.resolve(mktRoot, src);
    if (!within(mktRoot, root) || !(await realWithin(mktRoot, root))) throw new Error(`Plugin source escapes the marketplace: ${src}`);
  } else if (isObj(src)) {
    const identity = `${input.marketplace}/${input.plugin}`;
    if (src.source === 'github' && typeof src.repo === 'string') root = await cloneInto(`https://github.com/${src.repo}.git`, p, git, identity);
    else if ((src.source === 'url' || src.source === 'git' || src.source === 'git-subdir') && typeof src.url === 'string') {
      root = await cloneInto(src.url, p, git, identity);
      if (src.source === 'git-subdir' && typeof src.path === 'string') {
        const sub = path.resolve(root, src.path);
        if (!within(root, sub) || !(await realWithin(root, sub))) throw new Error(`Plugin subdirectory escapes the repository: ${src.path}`);
        root = sub;
      }
    } else throw new Error(`Unsupported plugin source for ${input.plugin}`);
  } else throw new Error(`Plugin ${input.plugin} has no source`);

  if (!(await stat(root))?.isDirectory()) throw new Error(`Plugin ${input.plugin} source not found at ${root}`);
  return loadDir(root, input.plugin);
}

export async function loadCandidate(
  input: CandidateInput,
  p: ClaudePaths,
  git: GitRunner = runGit,
): Promise<{ sources: Source[]; items: Item[] }> {
  if (input.kind === 'git') {
    const dir = await cloneInto(input.url, p, git, input.url);
    return loadDir(dir, repoBase(input.url));
  }
  if (input.kind === 'marketplace') return loadMarketplace(input, p, git);

  const abs = path.resolve(input.path);
  const st = await stat(abs);
  if (!st) throw new Error(`Path does not exist: ${abs}`);
  if (st.isDirectory()) return loadDir(abs, path.basename(abs));
  if (path.basename(abs) === 'SKILL.md') return loadLoneSkill(abs);
  if (abs.toLowerCase().endsWith('.zip')) {
    const target = path.join(p.cacheDir, 'candidates', sha(`${abs}:${st.mtimeMs}`));
    const root = await extractZip(abs, target);
    return loadDir(root, path.basename(root) === path.basename(target) ? path.basename(abs, path.extname(abs)) : path.basename(root));
  }
  throw new Error(`No skill or plugin found: ${abs} is not a folder, SKILL.md or .zip`);
}
