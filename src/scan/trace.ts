import path from 'node:path';
import fs from 'node:fs/promises';
import type { ClaudePaths } from '../paths.js';
import type { Item, ItemKind } from '../model.js';
import { readText, walkDirs } from '../util/fs.js';
import { cosine } from '../util/text.js';

export type Template = { plugin: string; version: string; relPath: string; text: string; kind: 'skill' | 'agent' | 'command'; name: string };

const MIN_SIMILARITY = 0.6;
const SKIP = new Set(['node_modules', '.git']);

async function* versionRoots(cache: string): AsyncGenerator<{ plugin: string; version: string; root: string }> {
  const dirs = async (d: string) => {
    try {
      return (await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  for (const mp of await dirs(cache))
    for (const plugin of await dirs(path.join(cache, mp)))
      for (const version of await dirs(path.join(cache, mp, plugin))) yield { plugin, version, root: path.join(cache, mp, plugin, version) };
}

/**
 * Skill/agent/command files that plugins carry as templates: any SKILL.md outside `<version>/skills/<name>/SKILL.md`,
 * plus .md files in an `agents`/`commands` dir other than the plugin's top-level ones. All cached versions included.
 */
export async function collectTemplates(p: ClaudePaths): Promise<Template[]> {
  const out: Template[] = [];
  for await (const { plugin, version, root } of versionRoots(path.join(p.claudeDir, 'plugins', 'cache'))) {
    for await (const dir of walkDirs(root)) {
      const rel = path.relative(root, dir);
      const parts = rel === '' ? [] : rel.split(path.sep);
      if (parts.some((seg) => SKIP.has(seg))) continue;
      const base = path.basename(dir);
      let names: string[];
      try {
        names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name).sort();
      } catch {
        continue;
      }
      const add = async (file: string, kind: Template['kind'], name: string) => {
        const text = await readText(path.join(dir, file));
        if (text !== null) out.push({ plugin, version, relPath: path.join(rel, file).split(path.sep).join('/'), text, kind, name });
      };
      if (names.includes('SKILL.md') && !(parts.length === 2 && parts[0] === 'skills')) await add('SKILL.md', 'skill', base);
      if ((base === 'agents' || base === 'commands') && parts.length > 1) {
        for (const f of names.filter((n) => n.endsWith('.md'))) await add(f, base === 'agents' ? 'agent' : 'command', f.slice(0, -3));
      }
    }
  }
  return out;
}

const TRACEABLE: ItemKind[] = ['skill', 'agent', 'command'];

/**
 * Returns a new array. Project skills/agents/commands matching a same-kind, same-name template
 * (cosine >= 0.6, best score wins) are replaced by copies with `tracedFrom`; all other items are the same objects.
 */
export async function traceItems(items: Item[], templates: Template[]): Promise<Item[]> {
  return Promise.all(
    items.map(async (it) => {
      if (it.sourceId !== 'project' || !TRACEABLE.includes(it.kind)) return it;
      const cands = templates.filter((t) => t.kind === it.kind && t.name === it.name);
      if (cands.length === 0) return it;
      const text = await readText(it.path);
      if (text === null) return it;
      let best: { t: Template; score: number } | null = null;
      for (const t of cands) {
        const score = t.text === text ? 1 : cosine(text, t.text);
        if (score >= MIN_SIMILARITY && (!best || score > best.score)) best = { t, score };
      }
      if (!best) return it;
      return {
        ...it,
        tracedFrom: {
          plugin: best.t.plugin,
          version: best.t.version,
          similarity: Math.round(best.score * 100) / 100,
          edited: best.t.text !== text,
        },
      };
    }),
  );
}
