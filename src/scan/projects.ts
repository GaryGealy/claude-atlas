import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { ClaudePaths } from '../paths.js';
import { readText } from '../util/fs.js';

export type ProjectEntry = { path: string; name: string; lastUsed: string | null };

const TEMP_PREFIXES = ['/private/var/folders/', '/var/folders/', '/tmp/'];

export function encodeProjectDir(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

/** Reads lines until the first one carrying a string `cwd`; never loads the whole file. */
async function firstCwd(file: string): Promise<string | null> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch {
        // unparseable line: skip
      }
    }
  } catch {
    // unreadable file
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

async function transcriptCwds(projectsDir: string): Promise<string[]> {
  const found = new Set<string>();
  let dirs: string[];
  try {
    dirs = (await fsp.readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = (await fsp.readdir(path.join(projectsDir, d))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const cwd = await firstCwd(path.join(projectsDir, d, f));
      if (cwd) {
        found.add(cwd);
        break; // one transcript per dir is enough to identify its project
      }
    }
  }
  return [...found];
}

async function newestTranscriptMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const m = (await fsp.stat(path.join(dir, f))).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      // vanished
    }
  }
  return newest;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function listProjects(p: ClaudePaths): Promise<ProjectEntry[]> {
  const candidates = new Set<string>();
  const text = await readText(p.claudeJson);
  if (text !== null) {
    try {
      const projects = (JSON.parse(text) as { projects?: unknown }).projects;
      if (projects && typeof projects === 'object') for (const k of Object.keys(projects)) candidates.add(k);
    } catch {
      // malformed .claude.json: fall back to transcripts only
    }
  }
  const projectsDir = path.join(p.claudeDir, 'projects');
  for (const c of await transcriptCwds(projectsDir)) candidates.add(c);

  const entries: ProjectEntry[] = [];
  for (const dir of candidates) {
    // Temp dirs are noise, unless they live under the configured home. The exemption exists because
    // fixtureHome() is itself created in os.tmpdir() (/private/var/folders on macOS); without it every
    // fixture project would be filtered. A real home is never under a temp prefix.
    const underHome = dir === p.home || dir.startsWith(p.home + path.sep);
    if (!underHome && TEMP_PREFIXES.some((t) => dir.startsWith(t))) continue;
    if (!(await isDir(dir))) continue;
    const mtime = await newestTranscriptMtime(path.join(projectsDir, encodeProjectDir(dir)));
    entries.push({
      path: dir,
      name: path.basename(dir),
      lastUsed: mtime === null ? null : new Date(mtime).toISOString(),
    });
  }
  entries.sort((a, b) => {
    if (a.lastUsed === b.lastUsed) return a.path.localeCompare(b.path);
    if (a.lastUsed === null) return 1;
    if (b.lastUsed === null) return -1;
    return a.lastUsed < b.lastUsed ? 1 : -1;
  });
  return entries;
}
