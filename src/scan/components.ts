import fs from 'node:fs/promises';
import path from 'node:path';
import type { Item } from '../model.js';
import { readHead, readText, walkDirs } from '../util/fs.js';
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
const SCRIPT_EXTS = new Set(['', '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.lua', '.cmd', '.bat', '.ps1']);
const MAX_FOLLOW_TOKENS = 8;

/** Returns the script bodies a hook command runs (each ≤4 KB), in order. */
export type ScriptResolver = (cmd: string) => Promise<string[]>;
export type ScriptResolverOpts = {
  /** Directory the first path-like token resolves against. */
  base: string;
  /** A script is read only when its real path lies under one of these roots. */
  allowed: string[];
  /** Variables substituted in the command (`${NAME}` and `$NAME`). */
  vars?: Record<string, string>;
  /** Expands `~/` in tokens. */
  home?: string;
  /** Dirs (besides the first script's dir) where later bare/relative tokens are looked up, e.g. the plugin root. */
  extraDirs?: string[];
};

async function realRoots(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of dirs) {
    try {
      out.push(await fs.realpath(d));
    } catch {
      // a root that does not exist allows nothing
    }
  }
  return out;
}

const under = (file: string, root: string): boolean => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads ≤4 KB of a script-like text file whose real path is under an allowed root; null when missing, binary, a non-script or outside. */
async function readScript(file: string, roots: string[]): Promise<{ real: string; text: string } | null> {
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch {
    return null;
  }
  if (!roots.some((r) => under(real, r))) return null;
  const head = await readHead(real, HOOK_TEXT_MAX);
  if (!head || head.includes(0)) return null;
  const text = head.toString('utf8');
  if (!SCRIPT_EXTS.has(path.extname(real).toLowerCase()) && !text.startsWith('#!')) return null;
  return { real, text };
}

/**
 * Builds a resolver for hook commands. The first path-like token is the script; later bare or relative tokens
 * (e.g. the `session-start` in `run-hook.cmd session-start`) are tried as files in that script's dir and in
 * `extraDirs`. Files outside `allowed`, binary files and non-scripts are never read.
 */
export function makeScriptResolver(o: ScriptResolverOpts): ScriptResolver {
  let roots: Promise<string[]> | null = null;
  return async (cmd) => {
    roots ??= realRoots(o.allowed);
    const allowed = await roots;
    let c = cmd;
    for (const [k, v] of Object.entries(o.vars ?? {})) c = c.replace(new RegExp(`\\$\\{${escapeRe(k)}\\}|\\$${escapeRe(k)}(?!\\w)`, 'g'), () => v);
    c = c.replace(/"([^"]*)"(?=[^\s"])/g, '$1'); // "$VAR"/rest -> glue quoted prefix to the remainder
    const tokens = (c.match(/"[^"]+"|'[^']+'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
    const first = tokens.findIndex((t) => t.includes('/'));
    if (first < 0) return [];
    const expand = (t: string): string => (o.home && (t === '~' || t.startsWith('~/')) ? path.join(o.home, t.slice(1)) : t);

    const bodies: string[] = [];
    const seen = new Set<string>();
    const add = (r: { real: string; text: string } | null): boolean => {
      if (!r || seen.has(r.real)) return false;
      seen.add(r.real);
      bodies.push(r.text);
      return true;
    };
    const main = await readScript(path.resolve(o.base, expand(tokens[first]!)), allowed);
    add(main);
    const dirs = [...(main ? [path.dirname(main.real)] : []), ...(o.extraDirs ?? [])];
    for (const tok of tokens.slice(first + 1, first + 1 + MAX_FOLLOW_TOKENS)) {
      if (!tok || tok.startsWith('-') || tok.startsWith('/') || tok.startsWith('~') || /[$=;|&<>`]/.test(tok)) continue;
      for (const d of dirs) if (add(await readScript(path.resolve(d, tok), allowed))) break;
    }
    return bodies;
  };
}

/** Resolver for a plugin's hooks: substitutes ${CLAUDE_PLUGIN_ROOT}; reads only files whose real path is under the plugin root. */
export function pluginScriptResolver(root: string): ScriptResolver {
  const absRoot = path.resolve(root);
  return makeScriptResolver({ base: absRoot, allowed: [absRoot], vars: { CLAUDE_PLUGIN_ROOT: absRoot }, extraDirs: [absRoot] });
}

/** Does the hook mention skills? Script bodies count, and the command's own words, but not a path inside it. */
function mentionsSkills(command: string, bodies: string[]): boolean {
  const words = (command.match(/"[^"]+"|'[^']+'|\S+/g) ?? []).filter((t) => !t.includes('/'));
  return /skill/i.test(words.join(' ')) || bodies.some((b) => /skill/i.test(b));
}

export async function readHooks(
  hooksJson: unknown,
  sourceId: string,
  filePath: string,
  resolveScript: ScriptResolver,
  /** Optional per-event counters, shared across calls so ids stay unique when several files feed one source. */
  counters: Map<string, number> = new Map(),
): Promise<Item[]> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(hooksJson)) return [];
  const byEvent = isObj(hooksJson.hooks) ? hooksJson.hooks : hooksJson;
  const items: Item[] = [];
  for (const [event, groups] of Object.entries(byEvent)) {
    if (!Array.isArray(groups)) continue;
    let index = counters.get(event) ?? 0;
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : null;
      for (const h of group.hooks) {
        if (!isObj(h) || h.type !== 'command' || typeof h.command !== 'string') continue;
        const bodies = await resolveScript(h.command);
        const text = [h.command, ...bodies].join('\n').slice(0, HOOK_TEXT_MAX);
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
          hook: { event, matcher, command: h.command, text, mentionsSkills: mentionsSkills(h.command, bodies) },
        });
        index++;
      }
    }
    counters.set(event, index);
  }
  return items;
}
