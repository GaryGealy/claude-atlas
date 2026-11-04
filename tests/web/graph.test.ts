import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElementDefinition } from 'cytoscape';
import { fixtureHome } from '../fixtures.js';
import { buildModel } from '../../src/build.js';
import { EVERY_SESSION_ID, type AtlasModel, type Item, type ItemKind } from '../../src/model.js';
import { ALL_KINDS, defaultFilters, toElements, type Filters } from '../../web/graph.js';

let m: AtlasModel;
let cacheDir: string;

beforeAll(async () => {
  const { paths, projects } = fixtureHome();
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-web-cache-'));
  m = await buildModel({ ...paths, cacheDir }, projects.ringZero);
});
afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

const cls = (el: ElementDefinition | undefined): string[] => (typeof el?.classes === 'string' ? el.classes.split(/\s+/).filter(Boolean) : []);
const byId = (els: ElementDefinition[], id: string): ElementDefinition | undefined => els.find((e) => e.data.id === id);
const item = (pred: (i: Item) => boolean): Item => {
  const it = m.items.find(pred);
  if (!it) throw new Error('fixture item missing');
  return it;
};
const brain = (): Item => item((i) => i.fullName === 'superpowers:brainstorming');
const design = (): Item => item((i) => i.sourceId === 'project' && i.name === 'design');
const setup = (): Item => item((i) => i.fullName === 'rpi:setup');
const competesBetween = (els: ElementDefinition[], a: string, b: string): ElementDefinition | undefined =>
  els.find((e) => e.data.source && cls(e).includes('competes') && [e.data.source, e.data.target].sort().join() === [a, b].sort().join());
const filters = (over: Partial<Filters> = {}): Filters => ({ ...defaultFilters(m), ...over });

describe('toElements', () => {
  it('maps sources to left-column nodes with class src-<kind>', () => {
    const els = toElements(m, filters());
    expect(cls(byId(els, 'plugin:superpowers'))).toEqual(expect.arrayContaining(['source', 'src-plugin']));
    expect(cls(byId(els, 'project'))).toContain('src-project');
    expect(cls(byId(els, 'mcp:user'))).toContain('src-mcp');
    expect(cls(byId(els, 'plugin:rpi'))).toContain('disabled');
  });

  it('gives items kind, disabled, conditional and traced classes', () => {
    const els = toElements(m, filters());
    expect(cls(byId(els, brain().id))).toEqual(expect.arrayContaining(['item', 'kind-skill']));
    expect(cls(byId(els, brain().id))).not.toContain('disabled');
    expect(cls(byId(els, setup().id))).toContain('disabled');
    expect(cls(byId(els, design().id))).toContain('traced');
    const cond = item((i) => i.kind === 'instruction' && i.conditional === true);
    expect(cls(byId(els, cond.id))).toEqual(expect.arrayContaining(['kind-instruction', 'conditional']));
    const hook = item((i) => i.kind === 'hook' && i.sourceId === 'plugin:superpowers');
    expect(cls(byId(els, hook.id))).toContain('kind-hook');
  });

  it("outlines traced items in their plugin's color, distinct from other plugins", () => {
    const els = toElements(m, filters());
    const d = byId(els, design().id)!;
    expect(d.data.traceColor).toBe(byId(els, 'plugin:rpi')!.data.color);
    expect(d.data.traceColor).not.toBe(byId(els, 'plugin:superpowers')!.data.color);
    expect(d.data.traceColor).not.toBe(d.data.color);
  });

  it('marks candidate items as ghost', () => {
    const ghost: Item = { ...brain(), id: 'skill:candidate:x:brainstorm', sourceId: 'candidate:x', name: 'brainstorm', ghost: true, fired: undefined };
    const withCand: AtlasModel = {
      ...m,
      sources: [...m.sources, { id: 'candidate:x', kind: 'candidate', label: 'Candidate: x', enabled: true, decidedBy: null }],
      items: [...m.items, ghost],
    };
    const els = toElements(withCand, { ...defaultFilters(withCand) });
    expect(cls(byId(els, ghost.id))).toContain('ghost');
    expect(cls(byId(els, 'candidate:x'))).toContain('src-candidate');
  });

  it('classes competes, injects and provides edges and synthesizes the every-session node', () => {
    const els = toElements(m, filters());
    const comp = competesBetween(els, brain().id, design().id);
    expect(comp).toBeTruthy();
    const inj = els.filter((e) => cls(e).includes('injects'));
    expect(inj.length).toBeGreaterThan(0);
    expect(inj.every((e) => e.data.target === EVERY_SESSION_ID)).toBe(true);
    expect(cls(byId(els, EVERY_SESSION_ID))).toContain('every-session');
    expect(els.some((e) => cls(e).includes('provides') && e.data.source === 'project' && e.data.target === design().id)).toBe(true);
  });

  it('default view: incident pairs between enabled items show; edges touching a disabled item are hidden', () => {
    const els = toElements(m, filters());
    const createPlan = item((i) => i.name === 'create-plan' && i.sourceId === 'project');
    const wp = item((i) => i.fullName === 'superpowers:writing-plans');
    expect(cls(competesBetween(els, brain().id, design().id))).not.toContain('weak');
    expect(competesBetween(els, wp.id, createPlan.id)).toBeTruthy();
    const bd = m.edges.find((e) => e.id === competesBetween(els, brain().id, design().id)!.data.id)!;
    expect(bd.competes!.tilt.some((t) => t.kind === 'hook-injects' && t.itemId === brain().id)).toBe(true);
    expect(competesBetween(els, setup().id, design().id)).toBeUndefined();
    expect(els.filter((e) => cls(e).includes('competes')).every((e) => !cls(e).includes('weak'))).toBe(true);
    // Fewer competes drawn than exist in the model.
    expect(els.filter((e) => cls(e).includes('competes')).length).toBeLessThan(m.edges.filter((e) => e.kind === 'competes').length);
  });

  it('Show all competes draws every pair, edges touching a disabled item faint (weak)', () => {
    const els = toElements(m, filters({ allCompetes: true }));
    expect(cls(competesBetween(els, setup().id, design().id) ?? competesBetween(els, setup().id, item((i) => i.name === 'create-plan' && i.sourceId === 'project').id))).toContain('weak');
    expect(cls(competesBetween(els, brain().id, design().id))).not.toContain('weak');
    expect(els.filter((e) => cls(e).includes('competes')).length).toBe(m.edges.filter((e) => e.kind === 'competes').length);
  });

  it('with showDisabled false drops disabled items, disabled sources and their edges', () => {
    const els = toElements(m, filters({ showDisabled: false }));
    expect(byId(els, setup().id)).toBeUndefined();
    expect(byId(els, 'plugin:rpi')).toBeUndefined();
    expect(els.some((e) => e.data.source === setup().id || e.data.target === setup().id)).toBe(false);
    expect(byId(els, brain().id)).toBeTruthy();
  });

  it('filtering kinds to skill drops hooks and the every-session node, unless a hook is kept', () => {
    const skills = toElements(m, filters({ kinds: new Set<ItemKind>(['skill']) }));
    expect(skills.some((e) => cls(e).includes('kind-hook'))).toBe(false);
    expect(skills.some((e) => cls(e).includes('kind-instruction'))).toBe(false);
    expect(byId(skills, EVERY_SESSION_ID)).toBeUndefined();
    expect(skills.some((e) => cls(e).includes('injects'))).toBe(false);
    expect(byId(skills, 'mcp:user')).toBeUndefined();
    const withHooks = toElements(m, filters({ kinds: new Set<ItemKind>(['skill', 'hook']) }));
    expect(byId(withHooks, EVERY_SESSION_ID)).toBeTruthy();
  });

  it('filtering sources drops that source, its items and edges', () => {
    const sources = new Set(m.sources.map((s) => s.id).filter((id) => id !== 'plugin:superpowers'));
    const els = toElements(m, filters({ sources }));
    expect(byId(els, 'plugin:superpowers')).toBeUndefined();
    expect(byId(els, brain().id)).toBeUndefined();
    expect(byId(els, EVERY_SESSION_ID)).toBeUndefined();
    expect(byId(els, design().id)).toBeTruthy();
  });

  it("search 'brain' keeps brainstorming and its competitors and fades the rest", () => {
    const els = toElements(m, filters({ search: 'brain' }));
    const createPlan = item((i) => i.sourceId === 'project' && i.name === 'create-plan');
    expect(cls(byId(els, brain().id))).not.toContain('faded');
    expect(cls(byId(els, design().id))).not.toContain('faded');
    expect(cls(byId(els, createPlan.id))).not.toContain('faded');
    expect(cls(byId(els, 'plugin:superpowers'))).not.toContain('faded');
    expect(cls(competesBetween(els, brain().id, design().id))).not.toContain('faded');
    const notes = item((i) => i.name === 'my-notes');
    expect(cls(byId(els, notes.id))).toContain('faded');
    const wp = item((i) => i.fullName === 'superpowers:writing-plans');
    expect(cls(byId(els, wp.id))).toContain('faded');
    expect(cls(competesBetween(els, wp.id, createPlan.id))).toContain('faded');
    // Nothing is removed by search, only faded.
    expect(els.length).toBe(toElements(m, filters()).length);
  });

  it('lays out sources left, items middle, every-session right, with no overlapping items', () => {
    const els = toElements(m, filters());
    const nodes = els.filter((e) => !e.data.source);
    expect(nodes.every((n) => n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    const xs = (c: string) => nodes.filter((n) => cls(n).includes(c)).map((n) => n.position!.x);
    expect(Math.max(...xs('source'))).toBeLessThan(Math.min(...xs('item')));
    expect(Math.max(...xs('item'))).toBeLessThan(byId(els, EVERY_SESSION_ID)!.position!.x);
    const seen = new Set(nodes.filter((n) => cls(n).includes('item')).map((n) => `${n.position!.x},${n.position!.y}`));
    expect(seen.size).toBe(nodes.filter((n) => cls(n).includes('item')).length);
  });

  it('defaultFilters selects every kind and source and shows disabled items', () => {
    const f = defaultFilters(m);
    expect([...f.kinds].sort()).toEqual([...ALL_KINDS].sort());
    expect(f.sources.size).toBe(m.sources.length);
    expect(f.showDisabled).toBe(true);
    expect(f.search).toBe('');
    expect(f.allCompetes).toBe(false);
  });
});
