import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import type { Item, Source } from '../model.js';
import { readText } from '../util/fs.js';
import { pluginScriptResolver, readAgents, readCommands, readHooks, readSkills } from './components.js';
import type { ResolvedSettings } from './settings.js';

type Warn = (m: string) => void;
type Scope = 'user' | 'project' | 'local';
type Candidate = { key: string; name: string; marketplace: string; installPath: string | null; scope: Scope; version: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const USER_INSTALLED = 'user-installed';

async function readJson(file: string, warn: Warn): Promise<unknown | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    warn(`Invalid JSON in ${file}: ${(e as Error).message}`);
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function splitKey(key: string): { name: string; marketplace: string } {
  const at = key.lastIndexOf('@');
  return at > 0 ? { name: key.slice(0, at), marketplace: key.slice(at + 1) } : { name: key, marketplace: 'unknown' };
}

function scopeApplies(entry: Record<string, unknown>, projectDir: string | null): Scope | null {
  const scope = entry.scope === 'project' || entry.scope === 'local' ? entry.scope : 'user';
  if (scope === 'user') return 'user';
  const pp = typeof entry.projectPath === 'string' ? entry.projectPath : null;
  return pp && projectDir && path.resolve(pp) === path.resolve(projectDir) ? scope : null;
}

async function installedCandidates(p: ClaudePaths, projectDir: string | null, warn: Warn): Promise<Candidate[]> {
  const file = path.join(p.claudeDir, 'plugins', 'installed_plugins.json');
  const json = await readJson(file, warn);
  if (!isObj(json)) return [];
  const map = isObj(json.plugins) ? json.plugins : json; // v2 {version, plugins} or flat v1
  const out: Candidate[] = [];
  for (const [key, val] of Object.entries(map)) {
    const entries = Array.isArray(val) ? val : [val];
    for (const entry of entries) {
      if (!isObj(entry)) continue;
      const scope = scopeApplies(entry, projectDir);
      if (!scope) continue;
      const { name, marketplace } = splitKey(key);
      const installPath = typeof entry.installPath === 'string' && entry.installPath ? entry.installPath : null;
      out.push({ key, name, marketplace, installPath, scope, version: typeof entry.version === 'string' ? entry.version : null });
      break; // first entry whose scope applies
    }
  }
  return out;
}

async function userInstalledCandidates(p: ClaudePaths): Promise<Candidate[]> {
  const dir = path.join(p.claudeDir, 'plugins', USER_INSTALLED);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    try {
      if (!(await fs.stat(full)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ key: `${e.name}@${USER_INSTALLED}`, name: e.name, marketplace: USER_INSTALLED, installPath: full, scope: 'user', version: null });
  }
  return out;
}

/** Resolves a manifest path (string or array) to directories/files lying under root. */
function customPaths(root: string, v: unknown): string[] {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const out: string[] = [];
  for (const rel of list) {
    const abs = path.resolve(root, rel);
    if (abs === root || abs.startsWith(root + path.sep)) out.push(abs);
  }
  return out;
}

/** A manifest path may be a directory or a single .md file; files are read via their parent dir and filtered. */
async function readEntries(
  paths: string[],
  reader: (dir: string) => Promise<Item[]>,
): Promise<Item[]> {
  const out: Item[] = [];
  for (const p of paths) {
    let isFile = false;
    try {
      isFile = (await fs.stat(p)).isFile();
    } catch {
      // missing: reader yields nothing
    }
    if (isFile) out.push(...(await reader(path.dirname(p))).filter((i) => i.path === p));
    else out.push(...(await reader(p)));
  }
  return out;
}

function uniqueById(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

async function mcpFrom(root: string, manifest: Record<string, unknown>, warn: Warn): Promise<unknown[]> {
  const out: unknown[] = [];
  const inline = manifest.mcpServers;
  const wrap = (j: unknown) => (isObj(j) && isObj(j.mcpServers) ? j : { mcpServers: j });
  if (isObj(inline)) out.push(wrap(inline));
  else for (const f of customPaths(root, inline)) {
    const j = await readJson(f, warn);
    if (isObj(j)) out.push(wrap(j));
  }
  const dot = await readJson(path.join(root, '.mcp.json'), warn);
  if (isObj(dot)) out.push(wrap(dot));
  return out;
}

export async function scanPlugins(
  p: ClaudePaths,
  projectDir: string | null,
  s: ResolvedSettings,
  warn: Warn,
): Promise<{ sources: Source[]; items: Item[]; pluginMcp: { sourceId: string; json: unknown }[] }> {
  const sources: Source[] = [];
  const items: Item[] = [];
  const pluginMcp: { sourceId: string; json: unknown }[] = [];

  const candidates = [...(await installedCandidates(p, projectDir, warn)), ...(await userInstalledCandidates(p))];
  const seen = new Set<string>();
  for (const c of candidates) {
    const sourceId = `plugin:${c.name}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const decision = s.enabledPlugins[c.key];
    const enabled = decision?.value ?? false;
    const decidedBy = decision?.decidedBy ?? null;
    const root = c.installPath ? path.resolve(c.installPath) : null;

    if (!c.installPath || !root || !(await exists(root))) {
      warn(c.installPath ? `Plugin ${c.key} is missing on disk: ${c.installPath}` : `Plugin ${c.key} is missing on disk: entry has no installPath`);
      sources.push({
        id: sourceId, kind: 'plugin', label: c.name, enabled, decidedBy,
        plugin: { name: c.name, marketplace: c.marketplace, version: c.version ?? 'unknown', installPath: c.installPath ?? '', scope: c.scope },
      });
      continue;
    }

    const manifestRaw = await readJson(path.join(root, '.claude-plugin', 'plugin.json'), warn);
    const manifest = isObj(manifestRaw) ? manifestRaw : {};
    const version = c.version ?? (typeof manifest.version === 'string' ? manifest.version : 'unknown');
    sources.push({
      id: sourceId, kind: 'plugin', label: c.name, enabled, decidedBy,
      plugin: { name: c.name, marketplace: c.marketplace, version, installPath: c.installPath, scope: c.scope },
    });

    const skills = [
      ...(await readSkills(path.join(root, 'skills'), sourceId, c.name, warn)),
      ...(await Promise.all(customPaths(root, manifest.skills).map((d) => readSkills(d, sourceId, c.name, warn)))).flat(),
    ];
    const agents = [
      ...(await readAgents(path.join(root, 'agents'), sourceId, c.name, warn)),
      ...(await readEntries(customPaths(root, manifest.agents), (d) => readAgents(d, sourceId, c.name, warn))),
    ];
    const commands = [
      ...(await readCommands(path.join(root, 'commands'), sourceId, c.name, warn)),
      ...(await readEntries(customPaths(root, manifest.commands), (d) => readCommands(d, sourceId, c.name, warn))),
    ];

    const resolver = pluginScriptResolver(root);
    const hooks: Item[] = [];
    const hooksFile = path.join(root, 'hooks', 'hooks.json');
    const fileHooks = await readJson(hooksFile, warn);
    if (fileHooks !== null) hooks.push(...(await readHooks(fileHooks, sourceId, hooksFile, resolver)));
    const inlineHooks = manifest.hooks;
    const inlineSources: { json: unknown; file: string }[] = [];
    if (isObj(inlineHooks)) inlineSources.push({ json: inlineHooks, file: path.join(root, '.claude-plugin', 'plugin.json') });
    else for (const f of customPaths(root, inlineHooks)) inlineSources.push({ json: await readJson(f, warn), file: f });
    for (const h of inlineSources) {
      if (h.json === null) continue;
      for (const it of await readHooks(h.json, sourceId, h.file, resolver)) {
        const taken = new Set(hooks.map((x) => x.id));
        let id = it.id;
        for (let n = 1; taken.has(id); n++) id = `${it.id}:${n}`;
        hooks.push({ ...it, id });
      }
    }

    for (const it of uniqueById([...skills, ...agents, ...commands, ...hooks])) {
      let itemEnabled = enabled;
      let itemDecidedBy = decidedBy;
      if (it.kind === 'skill') {
        const ov = s.skillOverrides[it.name] ?? s.skillOverrides[it.fullName];
        if (ov?.value === 'off') {
          itemEnabled = false;
          itemDecidedBy = ov.decidedBy;
        }
      }
      items.push({ ...it, enabled: itemEnabled, decidedBy: itemDecidedBy });
    }

    for (const json of await mcpFrom(root, manifest, warn)) pluginMcp.push({ sourceId, json });
  }
  return { sources, items, pluginMcp };
}
