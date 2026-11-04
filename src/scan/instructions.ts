import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import type { Item } from '../model.js';
import { readText } from '../util/fs.js';
import { encodeProjectDir } from './projects.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

function describe(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line.slice(0, 200);
  }
  return '';
}

/** Returns `@path` tokens outside code fences and inline code spans. */
export function findImports(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const stripped = line.replace(/`[^`]*`/g, '');
    for (const m of stripped.matchAll(/(?:^|\s)@(\S+)/g)) {
      const tok = m[1]!.replace(/[.,;:!?)\]}]+$/, '');
      if (tok) out.push(tok);
    }
  }
  return out;
}

async function nestedClaudeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await rec(path.join(dir, e.name));
      else if (e.isFile() && e.name === 'CLAUDE.md' && dir !== root) found.push(path.join(dir, e.name));
    }
  }
  await rec(root);
  return found;
}

export async function scanInstructions(p: ClaudePaths, projectDir: string): Promise<Item[]> {
  const items: Item[] = [];
  const visited = new Set<string>();

  async function add(file: string, sourceId: string, root: string, conditional: boolean): Promise<void> {
    const abs = path.resolve(file);
    if (visited.has(abs)) return;
    const text = await readText(abs);
    if (text === null || !(await isFile(abs))) return;
    visited.add(abs);
    const item: Item = {
      id: `instruction:${sourceId}:${abs}`,
      kind: 'instruction',
      name: path.relative(root, abs),
      fullName: abs,
      sourceId,
      path: abs,
      description: describe(text),
      enabled: true,
      decidedBy: null,
    };
    if (conditional) item.conditional = true;
    items.push(item);
    for (const imp of findImports(text)) {
      const target = imp === '~' || imp.startsWith('~/') ? path.join(p.home, imp.slice(1)) : path.resolve(path.dirname(abs), imp);
      await add(target, sourceId, root, conditional);
    }
  }

  await add(path.join(p.claudeDir, 'CLAUDE.md'), 'user', p.claudeDir, false);

  const project = path.resolve(projectDir);
  const ancestors: string[] = [];
  for (let d = path.dirname(project); ; d = path.dirname(d)) {
    ancestors.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of ancestors) await add(path.join(d, 'CLAUDE.md'), 'project', project, false);
  await add(path.join(project, 'CLAUDE.md'), 'project', project, false);
  await add(path.join(project, 'CLAUDE.local.md'), 'project', project, false);
  await add(path.join(project, '.claude', 'CLAUDE.md'), 'project', project, false);
  try {
    const rules = (await fs.readdir(path.join(project, '.claude', 'rules'))).filter((f) => f.endsWith('.md')).sort();
    for (const f of rules) await add(path.join(project, '.claude', 'rules', f), 'project', project, false);
  } catch {
    // no rules dir
  }
  for (const f of await nestedClaudeFiles(project)) await add(f, 'project', project, true);

  const memDir = path.join(p.claudeDir, 'projects', encodeProjectDir(project), 'memory');
  const memIndex = path.join(memDir, 'MEMORY.md');
  if (await isFile(memIndex)) {
    let n = 0;
    for (const e of await fs.readdir(memDir, { withFileTypes: true })) if (e.isFile() && e.name !== 'MEMORY.md') n++;
    items.push({
      id: `memory:user:${memIndex}`,
      kind: 'memory',
      name: 'MEMORY.md',
      fullName: memIndex,
      sourceId: 'user',
      path: memIndex,
      description: `${n} memory files`,
      enabled: true,
      decidedBy: null,
    });
  }
  return items;
}
