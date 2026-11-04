// Which competes edges matter most. Pure (no node imports): shared by the server (judge) and the web UI (default view).
import type { Edge, Item } from '../model.js';

/** Edges at or above this strength show by default and are eligible for the judge. */
export const STRONG_COMPETES = 3;
/** At most this many pairs are sent to the judge per run. */
export const JUDGE_CAP = 25;

const byStrength = (a: Edge, b: Edge): number => (b.competes?.strength ?? 0) - (a.competes?.strength ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Competes edges between two enabled items, strongest first. */
function liveCompetes(edges: Edge[], items: Item[]): Edge[] {
  const enabled = new Set(items.filter((i) => i.enabled).map((i) => i.id));
  return edges.filter((e) => e.kind === 'competes' && e.competes && enabled.has(e.from) && enabled.has(e.to)).sort(byStrength);
}

/**
 * Ids of the competes edges shown by default: both ends enabled, and strength ≥ STRONG_COMPETES or the edge is the
 * single strongest edge of one of its items.
 */
export function defaultCompetes(edges: Edge[], items: Item[]): Set<string> {
  const shown = new Set<string>();
  const best = new Set<string>();
  for (const e of liveCompetes(edges, items)) {
    if (e.competes!.strength >= STRONG_COMPETES) shown.add(e.id);
    for (const end of [e.from, e.to]) {
      if (best.has(end)) continue;
      best.add(end);
      shown.add(e.id);
    }
  }
  return shown;
}

/** The pairs the judge runs on: enabled↔enabled with strength ≥ STRONG_COMPETES, strongest first, at most `cap`. */
export function judgeTargets(edges: Edge[], items: Item[], cap = JUDGE_CAP): Edge[] {
  return liveCompetes(edges, items)
    .filter((e) => e.competes!.strength >= STRONG_COMPETES)
    .slice(0, cap);
}
