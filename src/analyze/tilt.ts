import type { Edge, Item, Tilt } from '../model.js';
import { EVERY_SESSION_EVENTS } from './competes.js';

const IMPERATIVE = /\b(MUST|Use when|Use this when|before any|ALWAYS)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyTilt(edges: Edge[], items: Item[]): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hooks = items.filter((i) => i.kind === 'hook' && i.enabled && i.hook && EVERY_SESSION_EVENTS.includes(i.hook.event));

  const hookFor = (it: Item): Item | undefined =>
    hooks.find(
      (h) =>
        (h.sourceId === it.sourceId && h.hook!.mentionsSkills) ||
        new RegExp(`(?<![\\w-])${escapeRe(it.name)}(?![\\w-])`, 'i').test(h.hook!.text),
    );

  for (const e of edges) {
    if (!e.competes) continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const tilt: Tilt[] = [];
    for (const it of [a, b]) {
      const h = hookFor(it);
      if (h) {
        tilt.push({
          itemId: it.id,
          kind: 'hook-injects',
          detail: `${h.sourceId.replace(/^plugin:/, '')} ${h.hook!.event} hook injects skill-use instructions into every session`,
        });
      }
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
