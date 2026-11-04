import { describe, expect, it } from 'vitest';
import type { Edge, Item } from '../../src/model.js';
import { defaultCompetes, judgeTargets } from '../../src/analyze/strength.js';

const item = (id: string, enabled = true) => ({ id, enabled }) as Item;
const edge = (a: string, b: string, strength: number): Edge => ({
  id: `competes:${a}|${b}`,
  kind: 'competes',
  from: a,
  to: b,
  competes: { reasons: [], score: 0, strength, tilt: [] },
});

describe('defaultCompetes', () => {
  it('keeps strong enabled pairs plus each enabled item’s single strongest edge, never disabled ones', () => {
    const items = [item('a'), item('b'), item('c'), item('d'), item('off', false)];
    const edges = [edge('a', 'b', 3.5), edge('a', 'c', 1), edge('c', 'd', 0.5), edge('b', 'c', 0.5), edge('a', 'off', 5)];
    const shown = defaultCompetes(edges, items);
    expect([...shown].sort()).toEqual(['competes:a|b', 'competes:a|c', 'competes:c|d']);
  });

  it('puts strength exactly 3 in the strong tier; 2.5 shows only as an item’s single strongest edge', () => {
    const items = [item('a'), item('b'), item('c'), item('d'), item('e')];
    const edges = [edge('a', 'b', 3), edge('a', 'c', 2.5), edge('c', 'd', 2.5), edge('b', 'c', 2.9), edge('d', 'e', 2.5), edge('a', 'd', 2.4)];
    const shown = defaultCompetes(edges, items);
    expect(shown.has('competes:a|b')).toBe(true); // exactly 3: strong
    // a's best is a|b, b's best is a|b; c's best is b|c (2.9); d's best is c|d (2.5) -> shown only by the strongest rule; e's best is d|e
    expect(shown.has('competes:b|c')).toBe(true);
    expect(shown.has('competes:c|d')).toBe(true);
    expect(shown.has('competes:d|e')).toBe(true);
    // 2.5 and 2.4 that are nobody's strongest are hidden
    expect(shown.has('competes:a|c')).toBe(false);
    expect(shown.has('competes:a|d')).toBe(false);
  });
});

describe('judgeTargets', () => {
  it('only enabled pairs with strength ≥ 3, strongest first, capped', () => {
    const items = [item('a'), item('b'), item('c'), item('off', false)];
    const edges = [edge('a', 'b', 3), edge('a', 'c', 4), edge('b', 'c', 2.5), edge('a', 'off', 9)];
    expect(judgeTargets(edges, items).map((e) => e.id)).toEqual(['competes:a|c', 'competes:a|b']);
    expect(judgeTargets(edges, items, 1).map((e) => e.id)).toEqual(['competes:a|c']);
  });
});
