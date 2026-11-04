import path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import { readText } from '../util/fs.js';

export type Decided<T> = { value: T; decidedBy: string };
export type SettingsHook = { json: unknown; file: string; sourceId: 'user' | 'project' | 'managed' };
export type ResolvedSettings = {
  enabledPlugins: Record<string, Decided<boolean>>;
  skillOverrides: Record<string, Decided<string>>;
  hooks: SettingsHook[];
  warnings: string[];
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Merges settings layers lowest to highest: user, user local, project, project local, managed. */
export async function resolveSettings(p: ClaudePaths, projectDir: string | null): Promise<ResolvedSettings> {
  const layers: { file: string; sourceId: SettingsHook['sourceId'] }[] = [
    { file: path.join(p.claudeDir, 'settings.json'), sourceId: 'user' },
    { file: path.join(p.claudeDir, 'settings.local.json'), sourceId: 'user' },
  ];
  if (projectDir) {
    layers.push(
      { file: path.join(projectDir, '.claude', 'settings.json'), sourceId: 'project' },
      { file: path.join(projectDir, '.claude', 'settings.local.json'), sourceId: 'project' },
    );
  }
  layers.push({ file: path.join(p.managedDir, 'managed-settings.json'), sourceId: 'managed' });

  const out: ResolvedSettings = { enabledPlugins: {}, skillOverrides: {}, hooks: [], warnings: [] };
  const seen = new Set<string>();
  for (const { file, sourceId } of layers) {
    // When the project is the home dir its .claude/settings.json is the user file: read it once, as the user's.
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = await readText(file);
    if (text === null) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      out.warnings.push(`Invalid JSON in ${file}: ${(e as Error).message}; file skipped`);
      continue;
    }
    if (!isObj(json)) {
      out.warnings.push(`Invalid settings in ${file}: expected a JSON object; file skipped`);
      continue;
    }
    if (isObj(json.enabledPlugins)) {
      for (const [k, v] of Object.entries(json.enabledPlugins)) {
        if (typeof v === 'boolean') out.enabledPlugins[k] = { value: v, decidedBy: file };
      }
    }
    if (isObj(json.skillOverrides)) {
      for (const [k, v] of Object.entries(json.skillOverrides)) {
        if (typeof v === 'string') out.skillOverrides[k] = { value: v, decidedBy: file };
      }
    }
    if (isObj(json.hooks)) out.hooks.push({ json: json.hooks, file, sourceId });
  }
  return out;
}
