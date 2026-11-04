// Pure project-switch logic (unit-tested under node): commit a new project only when its model loads.
import type { AtlasModel } from '../src/model.js';
import type { ProjectEntry } from '../src/scan/projects.js';
import type { Filters } from './graph.js';
import type { Selection } from './panel.js';

export const OTHER = '__other__';

export type PickerOption = { value: string; label: string; title?: string };

/** Picker options: known projects, the current project if it was entered by hand, then "Enter a path…". */
export function pickerOptions(list: ProjectEntry[], current: string | null): PickerOption[] {
  const opts: PickerOption[] = list.map((p) => ({ value: p.path, label: p.name, title: p.path }));
  if (current && !list.some((p) => p.path === current)) opts.unshift({ value: current, label: current, title: current });
  opts.push({ value: OTHER, label: 'Enter a path…' });
  return opts;
}

export type ProjectView = { project: string | null; model: AtlasModel | null; filters: Filters | null; selection: Selection };

/**
 * Loads `path`. On success returns a fresh view for it (filters reset, nothing selected). On failure returns the
 * previous view unchanged plus the error, so the map, picker and actions keep pointing at the last good project.
 */
export async function switchProject(
  prev: ProjectView,
  path: string,
  load: (path: string) => Promise<AtlasModel>,
): Promise<{ view: ProjectView; ok: boolean; error: string | null }> {
  try {
    const model = await load(path);
    return { view: { project: path, model, filters: null, selection: null }, ok: true, error: null };
  } catch (e) {
    return { view: prev, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
