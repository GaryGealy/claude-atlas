import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { scanLocal } from '../../src/scan/local.js';
import { resolveSettings } from '../../src/scan/settings.js';

async function run(which: 'ringZero' | 'plain') {
  const { paths, projects } = fixtureHome();
  const dir = projects[which];
  const s = await resolveSettings(paths, dir);
  const warnings: string[] = [];
  const r = await scanLocal(paths, dir, s, (m) => warnings.push(m));
  return { paths, dir, r, warnings };
}

describe('scanLocal', () => {
  it('ring-zero has user, synced and project sources, no managed', async () => {
    const { r } = await run('ringZero');
    expect(r.sources.map((s) => s.id)).toEqual(['user', 'synced', 'project']);
    expect(r.sources.map((s) => s.label)).toEqual(['You (global)', 'claude.ai (synced)', 'ring-zero']);
    const names = (id: string, kind: string) => r.items.filter((i) => i.sourceId === id && i.kind === kind).map((i) => i.fullName).sort();
    expect(names('synced', 'skill')).toEqual(['anthropic-skills:brand-voice']);
    expect(names('project', 'skill')).toEqual(['create-plan', 'design', 'guide']);
    expect(names('user', 'skill')).toContain('my-notes');
    expect(names('user', 'skill')).not.toContain('anthropic-skills:brand-voice');
    expect(r.items.some((i) => i.kind === 'hook' && i.sourceId === 'user')).toBe(true);
  });

  it('adds a managed source with its hooks only when managedDir exists', async () => {
    const { paths, dir } = await run('ringZero');
    fs.mkdirSync(paths.managedDir, { recursive: true });
    fs.mkdirSync(path.join(paths.managedDir, 'skills', 'sec'), { recursive: true });
    fs.writeFileSync(path.join(paths.managedDir, 'skills', 'sec', 'SKILL.md'), '---\nname: sec\ndescription: d\n---\n');
    fs.writeFileSync(path.join(paths.managedDir, 'managed-settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo m' }] }] } }));
    const r = await scanLocal(paths, dir, await resolveSettings(paths, dir), () => {});
    expect(r.sources.map((s) => s.id)).toContain('managed');
    expect(r.items.filter((i) => i.sourceId === 'managed').map((i) => i.kind).sort()).toEqual(['hook', 'skill']);
  });

  it('applies skillOverrides off to user skills', async () => {
    const { paths, dir } = await run('ringZero');
    fs.writeFileSync(path.join(paths.claudeDir, 'settings.local.json'), JSON.stringify({ skillOverrides: { 'my-notes': 'off' } }));
    const r = await scanLocal(paths, dir, await resolveSettings(paths, dir), () => {});
    const it = r.items.find((i) => i.fullName === 'my-notes')!;
    expect(it.enabled).toBe(false);
    expect(it.decidedBy).toContain('settings.local.json');
  });

  it('resolves project hook scripts via CLAUDE_PROJECT_DIR', async () => {
    const { paths, dir } = await run('ringZero');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'h.sh'), 'echo load skill');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/scripts/h.sh' }] }] } }));
    const r = await scanLocal(paths, dir, await resolveSettings(paths, dir), () => {});
    const h = r.items.find((i) => i.kind === 'hook' && i.sourceId === 'project')!;
    expect(h.hook!.mentionsSkills).toBe(true);
  });

  it('keeps hook ids unique across settings layers sharing a source', async () => {
    const { paths, dir } = await run('ringZero');
    fs.writeFileSync(path.join(paths.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo a' }] }] } }));
    fs.writeFileSync(path.join(paths.claudeDir, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo b' }] }] } }));
    const r = await scanLocal(paths, dir, await resolveSettings(paths, dir), () => {});
    expect(r.items.filter((i) => i.kind === 'hook' && i.sourceId === 'user').map((i) => i.id)).toEqual(['hook:user:Stop:0', 'hook:user:Stop:1']);
  });

  it('plain project: project source exists with no items, nothing throws', async () => {
    const { r } = await run('plain');
    expect(r.sources.some((s) => s.id === 'project' && s.label === 'plain')).toBe(true);
    expect(r.items.filter((i) => i.sourceId === 'project')).toEqual([]);
  });
});
