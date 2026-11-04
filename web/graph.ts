// Pure model -> Cytoscape element mapping and preset layout. No DOM access here (unit-tested under node).
import type { ElementDefinition } from 'cytoscape';
import { EVERY_SESSION_ID, type AtlasModel, type Item, type ItemKind, type SourceKind } from '../src/model.js';

export type Filters = { kinds: Set<ItemKind>; sources: Set<string>; showDisabled: boolean; search: string };

export const ALL_KINDS: readonly ItemKind[] = ['skill', 'agent', 'command', 'hook', 'mcp-server', 'instruction', 'memory'];
export const KIND_LABELS: Record<ItemKind, string> = {
  skill: 'Skills',
  agent: 'Agents',
  command: 'Commands',
  hook: 'Hooks',
  'mcp-server': 'MCP',
  instruction: 'Instructions',
  memory: 'Memory',
};

export function defaultFilters(m: AtlasModel): Filters {
  return { kinds: new Set(ALL_KINDS), sources: new Set(m.sources.map((s) => s.id)), showDisabled: true, search: '' };
}

const KIND_COLORS: Record<SourceKind, string> = {
  user: '#2563eb',
  managed: '#475569',
  synced: '#0891b2',
  plugin: '#7c3aed',
  project: '#15803d',
  mcp: '#b45309',
  connectors: '#64748b',
  candidate: '#c2410c',
};
// Distinct per-plugin hues; red is reserved for "competes" and "injects".
// Greens are left out too, so a project skill's "made by <plugin>" outline stays distinguishable from the project's own green.
const PLUGIN_PALETTE = ['#7c3aed', '#ca8a04', '#4f46e5', '#0369a1', '#a21caf', '#9a3412', '#6d28d9', '#854d0e', '#1e40af', '#86198f'];

/**
 * Colors per source id, plus `plugin-name:<name>` keys for every plugin name (so a "made by <plugin>" outline can be
 * colored even when that plugin isn't a source). Plugins get palette colors in model order, so two plugins only share a
 * color once there are more plugins than palette entries.
 */
export function sourceColors(m: AtlasModel): Map<string, string> {
  const out = new Map<string, string>();
  const byPlugin = new Map<string, string>();
  const pluginColor = (name: string): string => {
    let c = byPlugin.get(name);
    if (!c) {
      c = PLUGIN_PALETTE[byPlugin.size % PLUGIN_PALETTE.length]!;
      byPlugin.set(name, c);
    }
    return c;
  };
  for (const s of m.sources) out.set(s.id, s.kind === 'plugin' ? pluginColor(s.plugin?.name ?? s.label) : KIND_COLORS[s.kind]);
  for (const it of m.items) if (it.tracedFrom) pluginColor(it.tracedFrom.plugin);
  for (const [name, c] of byPlugin) out.set(`plugin-name:${name}`, c);
  return out;
}

/** Mixes a #rrggbb color with white; used as an opaque fill so edges drawn underneath don't show through labels. */
export function tint(hex: string, white = 0.86): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number): string => Math.round(c + (255 - c) * white).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

// Layout geometry (px in model coordinates).
export const LAYOUT = {
  sourceX: 0,
  itemX0: 200,
  cellW: 168,
  cellH: 34,
  cols: 5,
  groupGap: 16,
  hookGap: 50,
  sessionGap: 220,
} as const;

const KIND_ORDER = new Map<ItemKind, number>(ALL_KINDS.map((k, i) => [k, i]));

function itemLabel(it: Item): string {
  const n = it.fired?.claude ?? 0;
  return n > 0 ? `${it.name}  ${n}×` : it.name;
}

function itemClasses(it: Item): string {
  const c = ['item', `kind-${it.kind}`];
  if (!it.enabled) c.push('disabled');
  if (it.ghost) c.push('ghost');
  if (it.conditional) c.push('conditional');
  if (it.tracedFrom) c.push('traced');
  if ((it.fired?.claude ?? 0) > 0) c.push('fired');
  return c.join(' ');
}

export function toElements(m: AtlasModel, f: Filters): ElementDefinition[] {
  const sourceById = new Map(m.sources.map((s) => [s.id, s]));
  const colors = sourceColors(m);
  const itemCount = new Map<string, number>();
  for (const it of m.items) itemCount.set(it.sourceId, (itemCount.get(it.sourceId) ?? 0) + 1);

  const items = m.items.filter((it) => {
    const src = sourceById.get(it.sourceId);
    return !!src && f.kinds.has(it.kind) && f.sources.has(it.sourceId) && (f.showDisabled || it.enabled);
  });
  const visibleItemIds = new Set(items.map((i) => i.id));
  const bySource = new Map<string, Item[]>();
  for (const it of items) {
    const list = bySource.get(it.sourceId) ?? [];
    list.push(it);
    bySource.set(it.sourceId, list);
  }
  // A source shows when it has visible items, or when it has no items at all (e.g. "missing on disk") and isn't filtered out.
  // Candidates go first, so ghost nodes sit at the top where they are noticed.
  const sources = m.sources
    .filter((s) => f.sources.has(s.id) && (bySource.has(s.id) || ((itemCount.get(s.id) ?? 0) === 0 && (f.showDisabled || s.enabled))))
    .sort((a, b) => Number(b.kind === 'candidate') - Number(a.kind === 'candidate'));

  // Edges that survive filtering.
  const present = new Set<string>([...sources.map((s) => s.id), ...visibleItemIds]);
  const edges = m.edges.filter((e) => {
    if (e.kind === 'injects') return visibleItemIds.has(e.from) && e.to === EVERY_SESSION_ID;
    return present.has(e.from) && present.has(e.to);
  });
  const hasSession = edges.some((e) => e.kind === 'injects');
  if (hasSession) present.add(EVERY_SESSION_ID);

  // Search: keep matches and their competitors, fade everything else.
  const q = f.search.trim().toLowerCase();
  let keep: Set<string> | null = null;
  if (q) {
    keep = new Set<string>();
    for (const it of items) if (it.name.toLowerCase().includes(q) || it.fullName.toLowerCase().includes(q)) keep.add(it.id);
    const matched = new Set(keep);
    for (const e of edges) {
      if (e.kind === 'competes') {
        if (matched.has(e.from)) keep.add(e.to);
        if (matched.has(e.to)) keep.add(e.from);
      } else if (e.kind === 'injects' && matched.has(e.from)) keep.add(EVERY_SESSION_ID);
    }
    for (const it of items) if (keep.has(it.id)) keep.add(it.sourceId);
  }
  const faded = (id: string): boolean => keep !== null && !keep.has(id);
  const fadeCls = (id: string): string => (faded(id) ? ' faded' : '');

  // Preset layout: sources in a left column, each source's items in a grid band beside it,
  // its hooks in a column to the right of the grid, and "every session" on the far right.
  const out: ElementDefinition[] = [];
  const hookX = LAYOUT.itemX0 + LAYOUT.cols * LAYOUT.cellW + LAYOUT.hookGap;
  const sessionX = hookX + LAYOUT.sessionGap;
  const hookYs: number[] = [];
  let y = 0;
  for (const s of sources) {
    const list = (bySource.get(s.id) ?? []).slice().sort((a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || a.name.localeCompare(b.name));
    const hooks = list.filter((i) => i.kind === 'hook');
    const grid = list.filter((i) => i.kind !== 'hook');
    const rows = Math.max(1, Math.ceil(grid.length / LAYOUT.cols), hooks.length);
    const color = colors.get(s.id)!;
    const srcCls = ['source', `src-${s.kind}`];
    if (!s.enabled) srcCls.push('disabled');
    out.push({
      group: 'nodes',
      data: { id: s.id, label: s.enabled ? s.label : `${s.label} (off)`, color, type: 'source' },
      classes: srcCls.join(' ') + fadeCls(s.id),
      position: { x: LAYOUT.sourceX, y: y + ((rows - 1) * LAYOUT.cellH) / 2 },
    });
    const pushItem = (it: Item, x: number, iy: number): void => {
      out.push({
        group: 'nodes',
        data: {
          id: it.id,
          label: itemLabel(it),
          color,
          fill: tint(color),
          traceColor: it.tracedFrom ? colors.get(`plugin-name:${it.tracedFrom.plugin}`)! : color,
          type: 'item',
        },
        classes: itemClasses(it) + fadeCls(it.id),
        position: { x, y: iy },
      });
    };
    grid.forEach((it, i) => pushItem(it, LAYOUT.itemX0 + (i % LAYOUT.cols) * LAYOUT.cellW, y + Math.floor(i / LAYOUT.cols) * LAYOUT.cellH));
    hooks.forEach((it, i) => {
      const hy = y + i * LAYOUT.cellH;
      pushItem(it, hookX, hy);
      if (edges.some((e) => e.kind === 'injects' && e.from === it.id)) hookYs.push(hy);
    });
    y += rows * LAYOUT.cellH + LAYOUT.groupGap;
  }

  if (hasSession) {
    const sy = hookYs.length ? hookYs.reduce((a, b) => a + b, 0) / hookYs.length : 0;
    out.push({
      group: 'nodes',
      data: { id: EVERY_SESSION_ID, label: 'every session', type: 'session' },
      classes: 'every-session' + fadeCls(EVERY_SESSION_ID),
      position: { x: sessionX, y: sy },
    });
  }

  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const e of edges) {
    const c: string[] = [e.kind];
    if (e.kind === 'competes') {
      const a = itemById.get(e.from);
      const b = itemById.get(e.to);
      if (!a?.enabled || !b?.enabled) c.push('weak');
      if (a?.ghost || b?.ghost) c.push('candidate');
      if (e.competes?.judge && !e.competes.judge.same) c.push('judged-different');
    }
    if (faded(e.from) || faded(e.to)) c.push('faded');
    out.push({ group: 'edges', data: { id: e.id, source: e.from, target: e.to, type: e.kind }, classes: c.join(' ') });
  }
  return out;
}
