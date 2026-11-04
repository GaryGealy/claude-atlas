import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import type { Item, Source } from '../model.js';
import { readText } from '../util/fs.js';
import { readAgents, readCommands, readHooks, readSkills } from './components.js';
import type { ResolvedSettings } from './settings.js';

type Warn = (m: string) => void;

function source(id: string, kind: Source['kind'], label: string): Source {
  return { id, kind, label, enabled: true, decidedBy: null };
}

/** Resolves the first path-like token of a hook command (against `root`, with project-dir vars substituted) and reads it. */
function scriptResolver(root: string, projectDir: string | null, home: string): (cmd: string) => Promise<string | null> {
  return async (cmd) => {
    let c = cmd;
    if (projectDir) c = c.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, projectDir);
    c = c.replace(/"([^"]*)"(?=[^\s"])/g, '$1'); // "$VAR"/rest -> glue quoted prefix to the remainder
    const tokens = c.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    for (const raw of tokens) {
      let tok = raw.replace(/^["']|["']$/g, '');
      if (!tok.includes('/')) continue;
      if (tok === '~' || tok.startsWith('~/')) tok = path.join(home, tok.slice(1));
      try {
        const file = path.resolve(root, tok);
        if ((await fs.stat(file)).isFile()) return await readText(file);
      } catch {
        // not a readable file
      }
      return null;
    }
    return null;
  };
}

function applyOverrides(items: Item[], s: ResolvedSettings): Item[] {
  return items.map((it) => {
    if (it.kind !== 'skill') return it;
    const ov = s.skillOverrides[it.name] ?? s.skillOverrides[it.fullName];
    return ov?.value === 'off' ? { ...it, enabled: false, decidedBy: ov.decidedBy } : it;
  });
}

async function dirItems(dir: string, sourceId: string, ns: string | null, s: ResolvedSettings, warn: Warn): Promise<Item[]> {
  const skills = applyOverrides(await readSkills(path.join(dir, 'skills'), sourceId, ns, warn), s);
  return [
    ...skills,
    ...(await readAgents(path.join(dir, 'agents'), sourceId, ns, warn)),
    ...(await readCommands(path.join(dir, 'commands'), sourceId, ns, warn)),
  ];
}

async function hookItems(s: ResolvedSettings, sourceId: 'user' | 'project' | 'managed', resolve: (c: string) => Promise<string | null>): Promise<Item[]> {
  const out: Item[] = [];
  const counters = new Map<string, number>();
  for (const h of s.hooks.filter((x) => x.sourceId === sourceId)) {
    // settings layers share a source id; the shared counters keep ids unique
    out.push(...(await readHooks(h.json, sourceId, h.file, resolve, counters)));
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function scanLocal(p: ClaudePaths, projectDir: string, s: ResolvedSettings, warn: Warn): Promise<{ sources: Source[]; items: Item[] }> {
  const sources: Source[] = [];
  const items: Item[] = [];

  sources.push(source('user', 'user', 'You (global)'));
  items.push(...(await dirItems(p.claudeDir, 'user', null, s, warn)));
  items.push(...(await hookItems(s, 'user', scriptResolver(p.home, null, p.home))));

  sources.push(source('synced', 'synced', 'claude.ai (synced)'));
  const syncedRoot = path.join(p.claudeDir, 'skills', 'synced');
  let orgs: string[] = [];
  try {
    orgs = (await fs.readdir(syncedRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // no synced skills
  }
  for (const org of orgs) items.push(...applyOverrides(await readSkills(path.join(syncedRoot, org), 'synced', 'anthropic-skills', warn), s));

  if (await exists(p.managedDir)) {
    sources.push(source('managed', 'managed', 'Managed'));
    items.push(...(await dirItems(p.managedDir, 'managed', null, s, warn)));
    items.push(...(await hookItems(s, 'managed', scriptResolver(p.managedDir, null, p.home))));
  }

  sources.push(source('project', 'project', path.basename(projectDir)));
  const claude = path.join(projectDir, '.claude');
  items.push(...(await dirItems(claude, 'project', null, s, warn)));
  items.push(...(await hookItems(s, 'project', scriptResolver(projectDir, projectDir, p.home))));

  return { sources, items };
}
