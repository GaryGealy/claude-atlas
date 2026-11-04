import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureHome } from '../fixtures.js';
import { resolveSettings } from '../../src/scan/settings.js';

describe('resolveSettings', () => {
  it('project layer overrides user; decidedBy names the winning file', async () => {
    const { paths, projects } = fixtureHome();
    const s = await resolveSettings(paths, projects.ringZero);
    expect(s.enabledPlugins['rpi@rpi-market']).toEqual({
      value: false,
      decidedBy: path.join(projects.ringZero, '.claude', 'settings.json'),
    });
    expect(s.enabledPlugins['superpowers@official'].value).toBe(true);
    expect(s.skillOverrides.wrangler.value).toBe('off');
  });

  it('with no project, user settings decide', async () => {
    const { paths } = fixtureHome();
    const s = await resolveSettings(paths, null);
    expect(s.enabledPlugins['rpi@rpi-market']).toEqual({
      value: true,
      decidedBy: path.join(paths.claudeDir, 'settings.json'),
    });
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0]).toMatchObject({ sourceId: 'user', file: path.join(paths.claudeDir, 'settings.json') });
  });

  it('applies the exact 5-layer order, managed last', async () => {
    const { paths, projects } = fixtureHome();
    const w = (f: string, o: unknown) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(o));
    };
    const pl = (v: boolean) => ({ enabledPlugins: { 'x@y': v } });
    w(path.join(paths.claudeDir, 'settings.local.json'), pl(true));
    w(path.join(projects.ringZero, '.claude', 'settings.local.json'), pl(false));
    expect((await resolveSettings(paths, projects.ringZero)).enabledPlugins['x@y'].value).toBe(false);
    const managed = path.join(paths.managedDir, 'managed-settings.json');
    w(managed, { ...pl(true), hooks: { Stop: [] } });
    const s = await resolveSettings(paths, projects.ringZero);
    expect(s.enabledPlugins['x@y']).toEqual({ value: true, decidedBy: managed });
    expect(s.hooks.map((h) => h.sourceId)).toEqual(['user', 'managed']);
  });

  it('warns on invalid JSON, skips that layer, keeps the others', async () => {
    const { paths, projects } = fixtureHome();
    const bad = path.join(projects.ringZero, '.claude', 'settings.local.json');
    fs.writeFileSync(bad, '{oops');
    const s = await resolveSettings(paths, projects.ringZero);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain(bad);
    expect(s.enabledPlugins['rpi@rpi-market'].value).toBe(false);
    expect(s.skillOverrides.wrangler.value).toBe('off');
  });
});
