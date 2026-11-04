import type { Edge, Item, Tilt } from '../model.js';
import { EVERY_SESSION_EVENTS } from './competes.js';

const IMPERATIVE = /\b(MUST|Use when|Use this when|before any|ALWAYS)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const hookLabel = (h: Item): string => `${h.sourceId.replace(/^plugin:/, '')} ${h.hook!.event} hook`;

export function applyTilt(edges: Edge[], items: Item[]): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hooks = items.filter((i) => i.kind === 'hook' && i.enabled && i.hook && EVERY_SESSION_EVENTS.includes(i.hook.event));
  const nameRe = new Map<string, RegExp>();
  const named = (it: Item, h: Item): boolean => {
    let re = nameRe.get(it.name);
    if (!re) nameRe.set(it.name, (re = new RegExp(`(?<![\\w-])${escapeRe(it.name)}(?![\\w-])`, 'i')));
    return re.test(h.hook!.text);
  };

  /** A hook whose text names the item wins over a generic skill-use hook from the item's own source. */
  const hookTilt = (it: Item, ghostEdge: boolean): Tilt | null => {
    // A candidate's hooks are not installed: they only tilt contests that involve a candidate item.
    const live = hooks.filter((h) => !h.ghost || ghostEdge);
    const byName = live.find((h) => named(it, h));
    if (byName) return { itemId: it.id, kind: 'hook-injects', detail: `${hookLabel(byName)} names ${it.name} in what it injects into every session` };
    const generic = live.find((h) => h.sourceId === it.sourceId && h.hook!.mentionsSkills);
    if (generic) return { itemId: it.id, kind: 'hook-injects', detail: `${hookLabel(generic)} injects skill-use instructions into every session` };
    return null;
  };

  for (const e of edges) {
    if (!e.competes) continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const tilt: Tilt[] = [];
    const ghostEdge = !!(a.ghost || b.ghost);
    for (const it of [a, b]) {
      const t = hookTilt(it, ghostEdge);
      if (t) tilt.push(t);
    }
    const ia = IMPERATIVE.test(a.description);
    const ib = IMPERATIVE.test(b.description);
    if (ia !== ib) {
      const w = ia ? a : b;
      tilt.push({ itemId: w.id, kind: 'imperative-wording', detail: `${w.name} is described in imperative wording ("MUST", "Use when"), so it is chosen first` });
    }
    for (const it of [a, b]) {
      if (!it.enabled) tilt.push({ itemId: it.id, kind: 'disabled', detail: `${it.fullName} is disabled, so it will not fire` });
    }
    e.competes.tilt = tilt;
  }
}
