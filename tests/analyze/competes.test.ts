import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { resolveSettings } from '../../src/scan/settings.js';
import { scanPlugins } from '../../src/scan/plugins.js';
import { scanLocal } from '../../src/scan/local.js';
import { findCompetes, injectEdges, phasesOf } from '../../src/analyze/competes.js';
import { applyTilt } from '../../src/analyze/tilt.js';
import { EVERY_SESSION_ID } from '../../src/model.js';

async function ringZeroItems() {
  const { paths, projects } = fixtureHome();
  const dir = projects.ringZero;
  const s = await resolveSettings(paths, dir);
  const p = await scanPlugins(paths, dir, s, () => {});
  const l = await scanLocal(paths, dir, s, () => {});
  return [...p.items, ...l.items];
}

describe('phasesOf', () => {
  it('matches whole words, plural, and split names', () => {
    expect(phasesOf('Create vertical implementation plans')).toEqual(['plan']);
    expect(phasesOf('writing-plans')).toEqual(['plan']);
    expect(phasesOf('Document codebase and open a Pull Request')).toEqual(['research', 'ship']);
    expect(phasesOf('implementation')).toEqual([]);
  });
});

describe('competes', () => {
  it('finds cross-source edges with tilt, none within a source', async () => {
    const items = await ringZeroItems();
    const edges = findCompetes(items);
    applyTilt(edges, items);
    const find = (x: string, y: string) =>
      edges.find((e) => {
        const n = [e.from, e.to].map((id) => items.find((i) => i.id === id)!.fullName);
        return n.some((v) => v.endsWith(x)) && n.some((v) => v === y);
      });
    const bd = find('brainstorming', 'design')!;
    expect(bd.competes!.reasons).toContain('phase:design');
    const wc = find('writing-plans', 'create-plan')!;
    expect(wc.competes!.reasons).toContain('phase:plan');
    expect(bd.id).toBe(`competes:${bd.from}|${bd.to}`);
    expect(bd.from < bd.to).toBe(true);

    const brain = items.find((i) => i.fullName.endsWith('brainstorming'))!;
    expect(bd.competes!.tilt.filter((t) => t.itemId === brain.id).map((t) => t.kind).sort()).toEqual(['hook-injects', 'imperative-wording']);
    expect(bd.competes!.tilt.every((t) => t.itemId === brain.id)).toBe(true);

    const sp = items.filter((i) => i.sourceId === 'plugin:superpowers' && i.kind === 'skill').map((i) => i.id);
    expect(edges.some((e) => sp.includes(e.from) && sp.includes(e.to))).toBe(false);
  });

  it('marks disabled sides and injects edges', async () => {
    const items = await ringZeroItems();
    const hooks = injectEdges(items);
    expect(hooks).toHaveLength(1);
    const h = items.find((i) => i.id === hooks[0].from)!;
    expect(h.hook!.event).toBe('SessionStart');
    expect(h.sourceId).toBe('plugin:superpowers');
    expect(hooks[0]).toMatchObject({ kind: 'injects', to: EVERY_SESSION_ID, id: `injects:${h.id}` });

    const a = { ...items.find((i) => i.name === 'design')!, enabled: false };
    const b = items.find((i) => i.fullName.endsWith('brainstorming'))!;
    const edges = findCompetes([a, b]);
    applyTilt(edges, [a, b]);
    expect(edges[0].competes!.tilt.some((t) => t.kind === 'disabled' && t.itemId === a.id)).toBe(true);
  });
});
