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

  it('reads the real superpowers layout: run-hook.cmd wrapper plus the named session-start script', async () => {
    const { paths } = fixtureHome();
    const root = pluginRoot(paths.home);
    const json = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
    const items = await readHooks(json, 'plugin:superpowers', path.join(root, 'hooks/hooks.json'), pluginScriptResolver(root));
    expect(items).toHaveLength(1);
    expect(items[0].hook).toMatchObject({ event: 'SessionStart', matcher: 'startup|clear|compact', mentionsSkills: true });
    expect(items[0].id).toBe('hook:plugin:superpowers:SessionStart:0');
    // The wrapper alone never mentions skills; the session-start script does.
    expect(fs.readFileSync(path.join(root, 'hooks/run-hook.cmd'), 'utf8')).not.toMatch(/skill/i);
    expect(items[0].hook!.text).toContain('CMDBLOCK');
    expect(items[0].hook!.text).toContain('using-superpowers/SKILL.md');
  });

  it('still reads a hook that runs its script directly', async () => {
    const { paths } = fixtureHome();
    const root = pluginRoot(paths.home);
    const json = { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh' }] }] };
    const [h] = await readHooks(json, 'plugin:superpowers', '/x', pluginScriptResolver(root));
    expect(h.hook!.mentionsSkills).toBe(true);
    expect(h.hook!.text).toContain('invoke the Skill tool');
  });

  it('accepts the bare settings.json hooks form', async () => {
    const items = await readHooks({ Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, 's', '/x', async () => []);
    expect(items).toHaveLength(1);
    expect(items[0].hook?.mentionsSkills).toBe(false);
  });

  it('redacts secrets in hook commands and resolved script text', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'hooks'));
    fs.writeFileSync(path.join(d, 'hooks/s.sh'), '#!/bin/sh\nexport API_TOKEN="tok-in-script"\ncurl -H "X-API-Key: hdr-in-script" https://h.io/x?key=q\n');
    const cmd = 'SECRET_KEY=cmd-secret ${CLAUDE_PLUGIN_ROOT}/hooks/s.sh --token tok-flag';
    const [h] = await readHooks({ SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }] }, 's', '/x', pluginScriptResolver(d));
    const all = JSON.stringify(h);
    for (const x of ['cmd-secret', 'tok-flag', 'tok-in-script', 'hdr-in-script', 'key=q']) expect(all).not.toContain(x);
    expect(h.hook!.command).toBe('SECRET_KEY=*** ${CLAUDE_PLUGIN_ROOT}/hooks/s.sh --token ***');
    expect(h.description).toBe(h.hook!.command);
    expect(h.hook!.text).toContain('API_TOKEN=***');
  });

  it('mentionsSkills comes from script bodies and command words, not a path that contains /skills/', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'skills/x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'skills/x/run.sh'), '#!/bin/sh\necho hello\n');
    const r = pluginScriptResolver(d);
    const [byPath] = await readHooks({ SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/skills/x/run.sh' }] }] }, 's', '/x', r);
    expect(byPath.hook!.mentionsSkills).toBe(false);
    const [byWords] = await readHooks({ SessionStart: [{ hooks: [{ type: 'command', command: 'echo "use your skills"' }] }] }, 's', '/x', r);
    expect(byWords.hook!.mentionsSkills).toBe(true);
  });

  it('plugin resolver stays inside the plugin root (real path), skips binary and non-script files, reads ≤4 KB', async () => {
    const d = tmp();
    const root = path.join(d, 'plugin');
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(d, 'outside.sh'), 'echo skill outside');
    fs.symlinkSync(path.join(d, 'outside.sh'), path.join(root, 'hooks/link.sh'));
    fs.writeFileSync(path.join(root, 'hooks/bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0x73, 0x6b, 0x69, 0x6c, 0x6c]));
    fs.writeFileSync(path.join(root, 'hooks/data.png'), 'skill');
    fs.writeFileSync(path.join(root, 'hooks/big.sh'), 'x'.repeat(10_000) + 'skill');
    const r = pluginScriptResolver(root);
    expect(await r('${CLAUDE_PLUGIN_ROOT}/hooks/link.sh')).toEqual([]);
    expect(await r('${CLAUDE_PLUGIN_ROOT}/../outside.sh')).toEqual([]);
    expect(await r('${CLAUDE_PLUGIN_ROOT}/hooks/bin')).toEqual([]);
    expect(await r('${CLAUDE_PLUGIN_ROOT}/hooks/data.png')).toEqual([]);
    const [big] = await r('${CLAUDE_PLUGIN_ROOT}/hooks/big.sh');
    expect(big.length).toBe(4096);
    expect(big).not.toContain('skill');
    // A follow-up token that escapes the root is not read either.
    expect(await r('${CLAUDE_PLUGIN_ROOT}/hooks/big.sh ../../outside.sh')).toHaveLength(1);
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
