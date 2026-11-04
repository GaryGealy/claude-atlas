import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureHome } from './fixtures.js';
import { buildModel } from '../src/build.js';
import { listProjects } from '../src/scan/projects.js';
import { EVERY_SESSION_ID, type Item, type Source } from '../src/model.js';

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out[path.relative(root, full)] = `${st.mtimeMs}:${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(root);
  return out;
}

function withTmpCache<T extends { cacheDir: string }>(paths: T): { paths: T; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cache-'));
  return { paths: { ...paths, cacheDir: dir }, dir };
}

describe('buildModel', () => {
  it('ring-zero: competes brainstorming<->design traced to rpi, fired counts, injects edges', async () => {
    const { paths, projects } = fixtureHome();
    const { paths: p, dir } = withTmpCache(paths);
    try {
      const m = await buildModel(p, projects.ringZero);
      const brain = m.items.find((i) => i.fullName === 'superpowers:brainstorming')!;
      const design = m.items.find((i) => i.sourceId === 'project' && i.name === 'design')!;
      expect(brain.fired?.claude).toBe(3);
      expect(design.tracedFrom?.plugin).toBe('rpi');
      const edge = m.edges.find((e) => e.kind === 'competes' && [e.from, e.to].sort().join() === [brain.id, design.id].sort().join());
      expect(edge).toBeTruthy();
      expect(m.edges.some((e) => e.kind === 'injects' && e.to === EVERY_SESSION_ID)).toBe(true);
      expect(m.edges.filter((e) => e.kind === 'provides').length).toBeGreaterThan(0);
      expect(m.project).toBe(projects.ringZero);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns about the oldtool plugin missing on disk', async () => {
    const { paths, projects } = fixtureHome();
    const { paths: p, dir } = withTmpCache(paths);
    try {
      const m = await buildModel(p, projects.ringZero);
      expect(m.warnings.some((w) => /oldtool/.test(w) && /missing on disk/.test(w))).toBe(true);
      expect(new Set(m.warnings).size).toBe(m.warnings.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plain project (no .claude) still includes plugin and user items', async () => {
    const { paths, projects } = fixtureHome();
    const { paths: p, dir } = withTmpCache(paths);
    try {
      const m = await buildModel(p, projects.plain);
      expect(m.items.some((i) => i.sourceId.startsWith('plugin:'))).toBe(true);
      expect(m.items.some((i) => i.sourceId === 'user')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges ghost candidates and dedupes ids with a warning', async () => {
    const { paths, projects } = fixtureHome();
    const { paths: p, dir } = withTmpCache(paths);
    try {
      const src: Source = { id: 'candidate:x', kind: 'candidate', label: 'x', enabled: true, decidedBy: null };
      const ghost: Item = {
        id: 'candidate:x|skill:brainstorm', kind: 'skill', name: 'brainstorm', fullName: 'x:brainstorm', sourceId: 'candidate:x',
        path: '/x', description: 'brainstorm and design ideas creatively', enabled: true, decidedBy: null,
      };
      const orphan: Item = { ...ghost, id: 'orphan', sourceId: 'nope' };
      const dup: Item = { ...ghost };
      const m = await buildModel(p, projects.ringZero, { candidate: { sources: [src], items: [ghost, orphan, dup] } });
      const got = m.items.filter((i) => i.id === ghost.id);
      expect(got).toHaveLength(1);
      expect(got[0].ghost).toBe(true);
      expect(m.warnings.some((w) => w.includes(ghost.id))).toBe(true);
      expect(m.warnings.some((w) => w.includes('orphan'))).toBe(true);
      expect(m.edges.some((e) => e.id === `provides:candidate:x|${ghost.id}`)).toBe(true);
      expect(m.edges.some((e) => e.kind === 'competes' && (e.from === ghost.id || e.to === ghost.id))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for a missing project directory', async () => {
    const { paths } = fixtureHome();
    await expect(buildModel(paths, path.join(paths.home, 'nope'))).rejects.toThrow(/does not exist|not a directory/i);
  });

  it('is read-only: fixture home is byte-identical and nothing new is created', async () => {
    const { paths, projects } = fixtureHome();
    const { paths: p, dir } = withTmpCache(paths);
    try {
      const listed = (await listProjects(p)).map((e) => e.path);
      const targets = [...new Set([...listed, projects.plain])];
      const before = snapshot(paths.home);
      for (const t of targets) {
        if (fs.existsSync(t)) await buildModel(p, t);
      }
      const after = snapshot(paths.home);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(after).toEqual(before);
      expect(targets.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
