import fs from 'node:fs/promises';
import path from 'node:path';
import type { Item } from '../model.js';
import { readText, walkDirs } from '../util/fs.js';
import { parseFrontmatter } from '../util/frontmatter.js';

type Warn = (m: string) => void;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const qualify = (ns: string | null, name: string) => (ns ? `${ns}:${name}` : name);

function makeItem(kind: 'skill' | 'agent' | 'command', sourceId: string, fullName: string, name: string, file: string, description: string): Item {
  return { id: `${kind}:${sourceId}:${fullName}`, kind, name, fullName, sourceId, path: file, description, enabled: true, decidedBy: null };
}

async function readMd(file: string, warn: Warn): Promise<ReturnType<typeof parseFrontmatter> | null> {
  const text = await readText(file);
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  if (fm.error) warn(`Invalid frontmatter in ${file}: ${fm.error}`);
  return fm;
}

export async function readSkills(dir: string, sourceId: string, ns: string | null, warn: Warn): Promise<Item[]> {
  const items: Item[] = [];
  const root = path.resolve(dir);
  for await (const d of walkDirs(dir, { warn, maxDepth: 1 })) {
    if (path.resolve(d) === root || path.basename(d) === 'synced') continue;
    const file = path.join(d, 'SKILL.md');
    const fm = await readMd(file, warn);
    if (!fm) continue;
    const name = str(fm.data.name) || path.basename(d);
    const description = str(fm.data.description);
    if (!fm.error && !description) warn(`Missing description in ${file}`);
    items.push(makeItem('skill', sourceId, qualify(ns, name), name, file, description));
  }
  return items;
}

export async function readAgents(dir: string, sourceId: string, ns: string | null, warn: Warn): Promise<Item[]> {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const items: Item[] = [];
  for (const f of entries.filter((e) => e.endsWith('.md')).sort()) {
    const file = path.join(dir, f);
    try {
      if (!(await fs.stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    const fm = await readMd(file, warn);
    if (!fm) continue;
    const name = str(fm.data.name) || f.slice(0, -3);
    const description = str(fm.data.description);
    if (!fm.error && !description) warn(`Missing description in ${file}`);
    items.push(makeItem('agent', sourceId, qualify(ns, name), name, file, description));
  }
  return items;
}

export async function readCommands(dir: string, sourceId: string, ns: string | null, warn: Warn): Promise<Item[]> {
  const items: Item[] = [];
  for await (const d of walkDirs(dir, { warn })) {
    let entries: string[];
    try {
      entries = await fs.readdir(d);
    } catch {
      continue;
    }
    for (const f of entries.filter((e) => e.endsWith('.md')).sort()) {
      const file = path.join(d, f);
      try {
        if (!(await fs.stat(file)).isFile()) continue;
      } catch {
        continue;
      }
      const fm = await readMd(file, warn);
      if (!fm) continue;
      const name = f.slice(0, -3);
      const description = str(fm.data.description) || (fm.body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '');
      items.push(makeItem('command', sourceId, qualify(ns, name), name, file, description));
    }
  }
  return items;
}

const HOOK_TEXT_MAX = 4096;

/** Builds a resolver that substitutes ${CLAUDE_PLUGIN_ROOT} and reads the first path-like token if it lies under `root`. */
export function pluginScriptResolver(root: string): (cmd: string) => Promise<string | null> {
  const absRoot = path.resolve(root);
  return async (cmd) => {
    const substituted = cmd.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, absRoot);
    const tokens = substituted.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    for (const raw of tokens) {
      const tok = raw.replace(/^["']|["']$/g, '');
      if (!tok.includes('/')) continue;
      const file = path.resolve(absRoot, tok);
      if (file !== absRoot && !file.startsWith(absRoot + path.sep)) continue;
      try {
        if ((await fs.stat(file)).isFile()) return await readText(file);
      } catch {
        // not a file; try the next token
      }
      return null; // only the first path-like token is considered
    }
    return null;
  };
}

export async function readHooks(
  hooksJson: unknown,
  sourceId: string,
  filePath: string,
  resolveScript: (cmd: string) => Promise<string | null>,
): Promise<Item[]> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(hooksJson)) return [];
  const byEvent = isObj(hooksJson.hooks) ? hooksJson.hooks : hooksJson;
  const items: Item[] = [];
  for (const [event, groups] of Object.entries(byEvent)) {
    if (!Array.isArray(groups)) continue;
    let index = 0;
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : null;
      for (const h of group.hooks) {
        if (!isObj(h) || h.type !== 'command' || typeof h.command !== 'string') continue;
        const script = await resolveScript(h.command);
        const text = (script ? `${h.command}\n${script}` : h.command).slice(0, HOOK_TEXT_MAX);
        items.push({
          id: `hook:${sourceId}:${event}:${index}`,
          kind: 'hook',
          name: event,
          fullName: event,
          sourceId,
          path: filePath,
          description: h.command,
          enabled: true,
          decidedBy: null,
          hook: { event, matcher, command: h.command, text, mentionsSkills: /skill/i.test(text) },
        });
        index++;
      }
    }
  }
  return items;
}
