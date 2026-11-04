import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureHome } from '../fixtures.js';
import { resolveSettings } from '../../src/scan/settings.js';
import { scanPlugins } from '../../src/scan/plugins.js';

async function scan(home: ReturnType<typeof fixtureHome>, project: string | null) {
  const warnings: string[] = [];
  const s = await resolveSettings(home.paths, project);
  const r = await scanPlugins(home.paths, project, s, (m) => warnings.push(m));
  return { ...r, warnings, s };
}

function addPlugin(home: ReturnType<typeof fixtureHome>, name: string, files: Record<string, string>) {
  const root = path.join(home.paths.claudeDir, 'plugins', 'user-installed', name);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const skillMd = (n: string) => `---\nname: ${n}\ndescription: does ${n}\n---\nbody`;

describe('scanPlugins', () => {
  it('reports enablement and scope for ring-zero', async () => {
    const h = fixtureHome();
    const { sources, items } = await scan(h, h.projects.ringZero);
    const byId = Object.fromEntries(sources.map((x) => [x.id, x]));
    expect(byId['plugin:superpowers'].enabled).toBe(true);
    expect(byId['plugin:rpi'].enabled).toBe(false);
    expect(byId['plugin:rpi'].decidedBy).toBe(path.join(h.projects.ringZero, '.claude', 'settings.json'));
    expect(byId['plugin:localtool']).toBeDefined();
    expect(byId['plugin:localtool'].plugin?.scope).toBe('project');
    expect(items.some((i) => i.fullName === 'superpowers:brainstorming' && i.enabled)).toBe(true);
    expect(items.find((i) => i.kind === 'hook' && i.sourceId === 'plugin:superpowers')?.enabled).toBe(true);
    expect(items.filter((i) => i.sourceId === 'plugin:rpi').every((i) => !i.enabled)).toBe(true);
  });

  it('omits project-scoped plugin for other projects', async () => {
    const h = fixtureHome();
    const { sources } = await scan(h, h.projects.plain);
    expect(sources.map((x) => x.id)).not.toContain('plugin:localtool');
    expect((await scan(h, null)).sources.map((x) => x.id)).not.toContain('plugin:localtool');
  });

  it('keeps a missing-on-disk plugin as a disabled source with a warning', async () => {
    const h = fixtureHome();
    const { sources, items, warnings } = await scan(h, h.projects.ringZero);
    const old = sources.find((x) => x.id === 'plugin:oldtool');
    expect(old?.enabled).toBe(false);
    expect(items.filter((i) => i.sourceId === 'plugin:oldtool')).toEqual([]);
    expect(warnings.some((w) => w.includes('missing on disk') && w.includes('oldtool@official'))).toBe(true);
  });

  it('honors custom skills path and user-installed plugins', async () => {
    const h = fixtureHome();
    addPlugin(h, 'custom', {
      '.claude-plugin/plugin.json': JSON.stringify({ version: '2.1.0', skills: './custom-skills' }),
      'custom-skills/alpha/SKILL.md': skillMd('alpha'),
    });
    const { sources, items } = await scan(h, null);
    expect(items.map((i) => i.fullName)).toContain('custom:alpha');
    const src = sources.find((x) => x.id === 'plugin:custom')!;
    expect(src.plugin).toMatchObject({ marketplace: 'user-installed', version: '2.1.0', scope: 'user' });
  });

  it('turns off a skill via skillOverrides, decided by the user settings file', async () => {
    const h = fixtureHome();
    const settingsFile = path.join(h.paths.claudeDir, 'settings.json');
    const j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    j.enabledPlugins['tools@user-installed'] = true;
    fs.writeFileSync(settingsFile, JSON.stringify(j));
    addPlugin(h, 'tools', { 'skills/wrangler/SKILL.md': skillMd('wrangler'), 'skills/other/SKILL.md': skillMd('other') });
    const { items } = await scan(h, null);
    const w = items.find((i) => i.name === 'wrangler')!;
    expect(w.enabled).toBe(false);
    expect(w.decidedBy).toBe(settingsFile);
    expect(items.find((i) => i.name === 'other')?.enabled).toBe(true);
  });

  it('collects inline hooks and mcp raw, and tolerates flat v1 installed_plugins', async () => {
    const h = fixtureHome();
    const root = addPlugin(h, 'inl', {
      '.claude-plugin/plugin.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        mcpServers: { srv: { command: 'x', env: { TOKEN: 'secret' } } },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }),
    });
    fs.writeFileSync(
      path.join(h.paths.claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ 'flat@mk': { scope: 'user', installPath: root, version: '1.2.3' } }),
    );
    const { sources, items, pluginMcp } = await scan(h, null);
    expect(sources.find((x) => x.id === 'plugin:flat')?.plugin?.marketplace).toBe('mk');
    expect(items.some((i) => i.kind === 'hook' && i.sourceId === 'plugin:flat' && i.name === 'SessionStart')).toBe(true);
    expect(pluginMcp.filter((m) => m.sourceId === 'plugin:flat')).toEqual([
      { sourceId: 'plugin:flat', json: { mcpServers: { srv: { command: 'x', env: { TOKEN: 'secret' } } } } },
      { sourceId: 'plugin:flat', json: { mcpServers: { other: { url: 'http://x' } } } },
    ]);
    expect(JSON.stringify(items)).not.toContain('secret');
  });

  it('keeps a plugin with no installPath as a disabled source with a warning', async () => {
    const h = fixtureHome();
    fs.writeFileSync(
      path.join(h.paths.claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'broken@mk': [{ scope: 'user', version: '1' }] } }),
    );
    const { sources, items, warnings } = await scan(h, null);
    expect(sources.find((x) => x.id === 'plugin:broken')?.enabled).toBe(false);
    expect(items.filter((i) => i.sourceId === 'plugin:broken')).toEqual([]);
    expect(warnings.some((w) => w.includes('missing on disk') && w.includes('broken@mk'))).toBe(true);
  });

  it('reads a single-file commands path and a single-file agents path', async () => {
    const h = fixtureHome();
    addPlugin(h, 'filey', {
      '.claude-plugin/plugin.json': JSON.stringify({ commands: './extra/one.md', agents: ['./extra/bot.md'] }),
      'extra/one.md': '---\ndescription: one\n---\nbody',
      'extra/two.md': '---\ndescription: two\n---\nbody',
      'extra/bot.md': '---\ndescription: bot\n---\nbody',
      'extra/bot2.md': '---\ndescription: bot2\n---\nbody',
    });
    const { items } = await scan(h, null);
    const mine = items.filter((i) => i.sourceId === 'plugin:filey').map((i) => i.fullName).sort();
    expect(mine).toEqual(['filey:bot', 'filey:one']);
  });
});
