import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClaudePaths } from './paths.js';
import { type AtlasModel, type Edge, type Item, type Source } from './model.js';
import { resolveSettings } from './scan/settings.js';
import { scanPlugins } from './scan/plugins.js';
import { scanLocal } from './scan/local.js';
import { scanInstructions } from './scan/instructions.js';
import { scanMcp } from './scan/mcp.js';
import { collectTemplates, traceItems } from './scan/trace.js';
import { applyFired, countFired } from './scan/fired.js';
import { loadJudgeSessions } from './analyze/judge.js';
import { findCompetes, injectEdges } from './analyze/competes.js';
import { applyTilt } from './analyze/tilt.js';

const DAY_MS = 86_400_000;

export type BuildOpts = { candidate?: { sources: Source[]; items: Item[] }; sinceMs?: number };

export async function buildModel(p: ClaudePaths, projectDir: string, opts: BuildOpts = {}): Promise<AtlasModel> {
  let isDir = false;
  try {
    isDir = (await fs.stat(projectDir)).isDirectory();
  } catch {
    /* handled below */
  }
  if (!isDir) throw new Error(`Project directory does not exist or is not a directory: ${projectDir}`);

  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const settings = await resolveSettings(p, projectDir);
  warnings.push(...settings.warnings);
  const plugins = await scanPlugins(p, projectDir, settings, warn);
  const local = await scanLocal(p, projectDir, settings, warn);
  const instructions = await scanInstructions(p, projectDir);
  const mcp = await scanMcp(p, projectDir, plugins.pluginMcp);

  const sources: Source[] = [];
  const seenSources = new Set<string>();
  const addSources = (list: Source[]): void => {
    for (const s of list) {
      if (seenSources.has(s.id)) continue;
      seenSources.add(s.id);
      sources.push(s);
    }
  };
  addSources([...local.sources, ...plugins.sources, ...mcp.sources]);

  // Plugin-provided MCP servers inherit the plugin's enabled state.
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  for (const it of mcp.items) {
    const src = sourceById.get(it.sourceId);
    if (src?.kind === 'plugin') {
      it.enabled = src.enabled;
      it.decidedBy = src.decidedBy;
    }
  }

  let items: Item[] = [...local.items, ...plugins.items, ...instructions, ...mcp.items];
  items = await traceItems(items, await collectTemplates(p));

  const judged = await loadJudgeSessions(path.join(p.cacheDir, 'judge-sessions.json'));
  const counts = await countFired(p, projectDir, { sinceMs: opts.sinceMs ?? Date.now() - 30 * DAY_MS, excludeSessionIds: judged });
  applyFired(items, counts);

  if (opts.candidate) {
    addSources(opts.candidate.sources);
    items.push(...opts.candidate.items.map((i) => ({ ...i, ghost: true })));
  }

  const seenItems = new Set<string>();
  items = items.filter((i) => {
    if (seenItems.has(i.id)) {
      warn(`Duplicate item id ignored: ${i.id}`);
      return false;
    }
    seenItems.add(i.id);
    return true;
  });

  const edges: Edge[] = [];
  const known = new Set(sources.map((s) => s.id));
  for (const it of items) {
    if (!known.has(it.sourceId)) {
      warn(`Item ${it.id} references unknown source ${it.sourceId}`);
      continue;
    }
    edges.push({ id: `provides:${it.sourceId}|${it.id}`, kind: 'provides', from: it.sourceId, to: it.id });
  }
  edges.push(...injectEdges(items), ...findCompetes(items));
  applyTilt(edges, items);

  return {
    project: projectDir,
    scannedAt: new Date().toISOString(),
    sources,
    items,
    edges,
    warnings: [...new Set(warnings)],
  };
}
