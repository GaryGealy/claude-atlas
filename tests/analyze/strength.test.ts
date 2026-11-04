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
    const edges = [edge('a', 'b', 2.5), edge('a', 'c', 1), edge('c', 'd', 0.5), edge('b', 'c', 0.5), edge('a', 'off', 5)];
    const shown = defaultCompetes(edges, items);
    expect([...shown].sort()).toEqual(['competes:a|b', 'competes:a|c', 'competes:c|d']);
  });
});

describe('judgeTargets', () => {
  it('only enabled pairs with strength ≥ 2, strongest first, capped', () => {
    const items = [item('a'), item('b'), item('c'), item('off', false)];
    const edges = [edge('a', 'b', 2), edge('a', 'c', 4), edge('b', 'c', 1.5), edge('a', 'off', 9)];
    expect(judgeTargets(edges, items).map((e) => e.id)).toEqual(['competes:a|c', 'competes:a|b']);
    expect(judgeTargets(edges, items, 1).map((e) => e.id)).toEqual(['competes:a|c']);
  });
});
