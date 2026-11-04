import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureHome } from '../fixtures.js';
import { readAgents, readCommands, readHooks, readSkills, pluginScriptResolver } from '../../src/scan/components.js';
import { parseFrontmatter } from '../../src/util/frontmatter.js';

const pluginRoot = (home: string) => path.join(home, '.claude/plugins/cache/official/superpowers/7.0.0');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-comp-')));

describe('parseFrontmatter', () => {
  it('parses data and body, and reports errors', () => {
    const ok = parseFrontmatter('---\nname: x\n---\nbody');
    expect(ok).toEqual({ data: { name: 'x' }, body: 'body', error: null });
    expect(parseFrontmatter('no fm').body).toBe('no fm');
    expect(parseFrontmatter('---\nname: [unclosed\n---\nb').error).toBeTruthy();
  });
});

describe('component readers', () => {
  it('reads plugin skills with namespace', async () => {
    const { paths } = fixtureHome();
    const items = await readSkills(path.join(pluginRoot(paths.home), 'skills'), 'plugin:superpowers', 'superpowers', () => {});
    const names = items.map((i) => i.fullName).sort();
    expect(names).toEqual(['superpowers:brainstorming', 'superpowers:writing-plans']);
    expect(items[0].id).toBe(`skill:plugin:superpowers:${items[0].fullName}`);
  });

  it('reads hooks with resolved script', async () => {
    const { paths } = fixtureHome();
    const root = pluginRoot(paths.home);
    const json = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
    const items = await readHooks(json, 'plugin:superpowers', path.join(root, 'hooks/hooks.json'), pluginScriptResolver(root));
    expect(items).toHaveLength(1);
    expect(items[0].hook).toMatchObject({ event: 'SessionStart', matcher: 'startup', mentionsSkills: true });
    expect(items[0].id).toBe('hook:plugin:superpowers:SessionStart:0');
  });

  it('accepts the bare settings.json hooks form', async () => {
    const items = await readHooks({ Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, 's', '/x', async () => null);
    expect(items).toHaveLength(1);
    expect(items[0].hook?.mentionsSkills).toBe(false);
  });

  it('skips synced dir', async () => {
    const { paths } = fixtureHome();
    const items = await readSkills(path.join(paths.claudeDir, 'skills'), 'user', null, () => {});
    expect(items.map((i) => i.fullName)).toEqual(['my-notes']);
  });

  it('broken frontmatter still yields an item and one warning', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'bad'));
    const f = path.join(d, 'bad/SKILL.md');
    fs.writeFileSync(f, '---\nname: [unclosed\n---\nbody');
    const warn = vi.fn();
    const items = await readSkills(d, 'user', null, warn);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('bad');
    expect(items[0].description).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(f);
  });

  it('follows symlinks and reports a loop once without hanging', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'real/a'), { recursive: true });
    fs.writeFileSync(path.join(d, 'real/a/SKILL.md'), '---\nname: a\ndescription: d\n---\n');
    fs.mkdirSync(path.join(d, 'skills'));
    fs.symlinkSync('../real/a', path.join(d, 'skills/a'));
    fs.symlinkSync('.', path.join(d, 'skills/loop'));
    const warn = vi.fn();
    const t = Date.now();
    const items = await readSkills(path.join(d, 'skills'), 'user', null, warn);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(items.map((i) => i.name)).toEqual(['a']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/loop/i);
  });

  it('reads agents and nested commands', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'agents'));
    fs.writeFileSync(path.join(d, 'agents/rev.md'), '---\nname: reviewer\ndescription: reviews\n---\nx');
    fs.mkdirSync(path.join(d, 'commands/sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'commands/top.md'), 'First line\nmore');
    fs.writeFileSync(path.join(d, 'commands/sub/deep.md'), '---\ndescription: deep one\n---\nbody');
    const agents = await readAgents(path.join(d, 'agents'), 'user', 'p', () => {});
    expect(agents[0]).toMatchObject({ kind: 'agent', fullName: 'p:reviewer', description: 'reviews' });
    const cmds = await readCommands(path.join(d, 'commands'), 'user', null, () => {});
    expect(cmds.map((c) => [c.name, c.description]).sort()).toEqual([['deep', 'deep one'], ['top', 'First line']]);
  });

  it('missing dirs yield no items', async () => {
    expect(await readSkills('/nope/nope', 'u', null, () => {})).toEqual([]);
  });
});
