import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { ClaudePaths } from '../paths.js';
import type { Item } from '../model.js';
import { encodeProjectDir } from './projects.js';

export type FiredCounts = Map<string, { claude: number; typed: number }>;

const COMMAND_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/g;

function bump(counts: FiredCounts, key: string, field: 'claude' | 'typed'): void {
  const entry = counts.get(key) ?? { claude: 0, typed: 0 };
  entry[field] += 1;
  counts.set(key, entry);
}

function typedNames(content: unknown): string[] {
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string') texts.push(t);
      }
    }
  }
  const names: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(COMMAND_RE)) {
      const name = m[1]!.replace(/^\//, '');
      if (name) names.push(name);
    }
  }
  return names;
}

async function countFile(file: string, sessionId: string, exclude: Set<string>, counts: FiredCounts): Promise<void> {
  if (exclude.has(sessionId)) return;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const hasTool = line.includes('"tool_use"');
      const hasCmd = line.includes('<command-name>');
      if (!hasTool && !hasCmd) continue;
      let obj: { type?: unknown; sessionId?: unknown; message?: { role?: unknown; content?: unknown } };
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // truncated or corrupt line
      }
      if (!obj || typeof obj !== 'object') continue;
      if (typeof obj.sessionId === 'string' && exclude.has(obj.sessionId)) continue;
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') continue;
      if (obj.type === 'assistant' && Array.isArray(msg.content)) {
        for (const b of msg.content as Array<{ type?: unknown; name?: unknown; input?: Record<string, unknown> }>) {
          if (!b || b.type !== 'tool_use' || !b.input) continue;
          if (b.name === 'Skill' && typeof b.input.skill === 'string') bump(counts, b.input.skill, 'claude');
          else if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input.subagent_type === 'string') {
            bump(counts, b.input.subagent_type, 'claude');
          }
        }
      } else if (obj.type === 'user' || msg.role === 'user') {
        for (const name of typedNames(msg.content)) bump(counts, name, 'typed');
      }
    }
  } catch {
    // unreadable file: contributes nothing
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function recent(file: string, sinceMs: number): Promise<boolean> {
  try {
    return (await fsp.stat(file)).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

/**
 * Counts Skill/Agent/Task tool calls and typed slash commands in a project's transcripts.
 * Keys: skill fullName, subagent_type, or typed command name (leading "/" stripped).
 * Skill and command keys can collide in one map; applyFired disambiguates by item kind.
 */
export async function countFired(
  p: ClaudePaths,
  projectDir: string,
  opts: { sinceMs: number; excludeSessionIds: Set<string> },
): Promise<FiredCounts> {
  const counts: FiredCounts = new Map();
  const dir = path.join(p.claudeDir, 'projects', encodeProjectDir(projectDir));
  for (const e of await safeReaddir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      if (await recent(full, opts.sinceMs)) await countFile(full, e.name.slice(0, -6), opts.excludeSessionIds, counts);
    } else if (e.isDirectory()) {
      if (opts.excludeSessionIds.has(e.name)) continue;
      const subDir = path.join(full, 'subagents');
      for (const s of await safeReaddir(subDir)) {
        if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
        const sf = path.join(subDir, s.name);
        if (await recent(sf, opts.sinceMs)) await countFile(sf, e.name, opts.excludeSessionIds, counts);
      }
    }
  }
  return counts;
}

/**
 * Sets `item.fired` on skill, agent and command items that have at least one count.
 * Items with no counts get NO `fired` field. Typed counts and Claude counts share one map
 * keyed by name; skills use Claude counts, commands use typed counts, agents use Claude counts.
 */
export function applyFired(items: Item[], counts: FiredCounts): void {
  for (const item of items) {
    if (item.kind !== 'skill' && item.kind !== 'agent' && item.kind !== 'command') continue;
    let claude = 0;
    let typed = 0;
    const keys = new Set<string>([item.fullName]);
    if (item.kind === 'agent') keys.add(item.name);
    for (const k of keys) claude += counts.get(k)?.claude ?? 0;
    // typed: un-namespaced typed names match item.name; namespaced match fullName
    typed += counts.get(item.fullName)?.typed ?? 0;
    if (item.name !== item.fullName) typed += counts.get(item.name)?.typed ?? 0;
    if (item.kind === 'agent') typed = 0;
    if (claude || typed) item.fired = { claude, typed };
  }
}
