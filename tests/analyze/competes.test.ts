import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { resolveSettings } from '../../src/scan/settings.js';
import { scanPlugins } from '../../src/scan/plugins.js';
import { scanLocal } from '../../src/scan/local.js';
import { findCompetes, injectEdges, phasesOf } from '../../src/analyze/competes.js';
import { applyTilt } from '../../src/analyze/tilt.js';
import { EVERY_SESSION_ID, type Item } from '../../src/model.js';

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

const mk = (id: string, sourceId: string, name: string, description: string): Item => ({
  id, kind: 'skill', name, fullName: name, sourceId, path: id, description, enabled: true, decidedBy: null,
});
const hook = (id: string, sourceId: string, text: string, mentionsSkills: boolean, ghost = false): Item => ({
  ...mk(id, sourceId, 'SessionStart', ''),
  kind: 'hook',
  ...(ghost ? { ghost: true } : {}),
  hook: { event: 'SessionStart', matcher: null, command: 'x', text, mentionsSkills },
});

describe('hook-injects tilt', () => {
  it('real superpowers layout: the fixture hook tilts brainstorming with generic skill-use wording', async () => {
    const items = await ringZeroItems();
    const edges = findCompetes(items);
    applyTilt(edges, items);
    const brain = items.find((i) => i.fullName === 'superpowers:brainstorming')!;
    const t = edges.flatMap((e) => e.competes!.tilt).find((x) => x.itemId === brain.id && x.kind === 'hook-injects')!;
    expect(t.detail).toBe('superpowers SessionStart hook injects skill-use instructions into every session');
  });

  it('says the hook names the item when the match came from the item name in hook text', () => {
    const a = mk('a', 's1', 'design', 'design things');
    const b = mk('b', 's2', 'sketch', 'design sketches');
    const items = [a, b, hook('h', 'user', 'echo "always run the design skill first"', false)];
    const edges = findCompetes(items);
    applyTilt(edges, items);
    expect(edges[0].competes!.tilt).toEqual([{ itemId: 'a', kind: 'hook-injects', detail: 'user SessionStart hook names design in what it injects into every session' }]);
  });

  it('a ghost (candidate) hook only tilts edges that touch a ghost item', () => {
    const a = mk('a', 's1', 'design', 'design things');
    const b = mk('b', 's2', 'sketch', 'design sketches');
    const g = { ...mk('g', 'candidate:x', 'draw', 'design drawings'), ghost: true };
    const items = [a, b, g, hook('h', 'candidate:x', 'use the design skill', true, true)];
    const edges = findCompetes(items);
    applyTilt(edges, items);
    const ab = edges.find((e) => e.from === 'a' && e.to === 'b')!;
    expect(ab.competes!.tilt).toEqual([]);
    const ag = edges.find((e) => [e.from, e.to].sort().join() === 'a,g')!;
    expect(ag.competes!.tilt.map((t) => [t.itemId, t.kind])).toEqual([
      ['a', 'hook-injects'],
      ['g', 'hook-injects'],
    ]);
  });
});

describe('findCompetes reasons', () => {
  it('flags name-collision across sources', () => {
    const edges = findCompetes([mk('a', 's1', 'helper', 'Alpha zeta'), mk('b', 's2', 'helper', 'Omega kappa')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].competes!.reasons).toEqual(['name-collision']);
  });

  it('flags similar-description without shared phase, and skips pairs under threshold', () => {
    const d = 'Manage tropical fruit baskets for weekly customer deliveries';
    const hit = findCompetes([mk('a', 's1', 'fruit', d), mk('b', 's2', 'basket', d + ' quickly')]);
    expect(hit).toHaveLength(1);
    expect(hit[0].competes!.reasons).toEqual(['similar-description']);
    expect(hit[0].competes!.score).toBeGreaterThanOrEqual(0.35);

    const a = mk('a', 's1', 'fruit', 'apple banana cherry date');
    const b = mk('b', 's2', 'basket', 'apple elder fig grape');
    expect(findCompetes([a, b])).toEqual([]);
    expect(findCompetes([a, b], 0.19)).toHaveLength(1);
  });
});
