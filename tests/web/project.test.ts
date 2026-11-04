import { describe, expect, it } from 'vitest';
import type { AtlasModel } from '../../src/model.js';
import { OTHER, pickerOptions, switchProject, type ProjectView } from '../../web/project.js';

const model = (project: string): AtlasModel => ({ project, scannedAt: '', sources: [], items: [], edges: [], warnings: [] });
const list = [
  { path: '/a', name: 'a', lastUsed: null },
  { path: '/b', name: 'b', lastUsed: null },
];

describe('switchProject', () => {
  const prev: ProjectView = { project: '/a', model: model('/a'), filters: null, selection: { type: 'node', id: 'x' } };

  it('commits the new project only when its model loads', async () => {
    const r = await switchProject(prev, '/b', async (p) => model(p));
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.view.project).toBe('/b');
    expect(r.view.model?.project).toBe('/b');
    expect(r.view.selection).toBeNull();
  });

  it('keeps the previous project, model and selection when loading fails', async () => {
    const r = await switchProject(prev, '/typo', async () => {
      throw new Error('Project directory not found: /typo');
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Project directory not found: /typo');
    expect(r.view).toBe(prev);
  });
});

describe('pickerOptions', () => {
  it('lists projects then "Enter a path…"', () => {
    expect(pickerOptions(list, '/a').map((o) => o.value)).toEqual(['/a', '/b', OTHER]);
  });

  it('includes a hand-entered current path, and drops it once current reverts after a failure', () => {
    expect(pickerOptions(list, '/typo').map((o) => o.value)).toEqual(['/typo', '/a', '/b', OTHER]);
    // After a failed switch the view keeps the previous project, so the bad path is no longer an option.
    expect(pickerOptions(list, '/a').map((o) => o.value)).not.toContain('/typo');
  });
});
