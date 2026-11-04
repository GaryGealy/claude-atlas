import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { fixtureHome } from './fixtures.js';
import { buildModel } from '../src/build.js';
import { loadCandidate } from '../src/candidate.js';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cand-')));
  made.push(d);
  return d;
};
const SKILL = '---\nname: research\ndescription: Research the codebase before planning\n---\nBody\n';
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const setup = () => {
  const { paths, projects } = fixtureHome();
  const cache = tmp();
  return { p: { ...paths, cacheDir: cache }, projects, cache };
};

describe('loadCandidate', () => {
  it('folder with a skill: one ghost item that competes with an existing item', async () => {
    const { p, projects } = setup();
    const dir = path.join(tmp(), 'research');
    write(path.join(dir, 'SKILL.md'), SKILL);
    const cand = await loadCandidate({ kind: 'path', path: dir }, p);
    expect(cand.sources).toEqual([{ id: 'candidate:research', kind: 'candidate', label: 'Candidate: research', enabled: true, decidedBy: null }]);
    expect(cand.items).toHaveLength(1);
    expect(cand.items[0]).toMatchObject({ ghost: true, enabled: true, decidedBy: null, sourceId: 'candidate:research', fullName: 'research' });
    const m = await buildModel(p, projects.ringZero, { candidate: cand });
    const edge = m.edges.find(
      (e) => e.kind === 'competes' && (e.from === cand.items[0].id || e.to === cand.items[0].id) && e.competes!.reasons.some((r) => r === 'phase:research' || r === 'phase:plan'),
    );
    expect(edge).toBeTruthy();
  });

  it('single SKILL.md file gives the same skill', async () => {
    const { p } = setup();
    const dir = path.join(tmp(), 'whatever');
    write(path.join(dir, 'SKILL.md'), SKILL);
    const cand = await loadCandidate({ kind: 'path', path: path.join(dir, 'SKILL.md') }, p);
    expect(cand.items.map((i) => i.fullName)).toEqual(['research']);
  });

  it('zip (with a single top-level folder) gives the same item, extracted under cacheDir', async () => {
    const { p, cache } = setup();
    const zip = path.join(tmp(), 'research.zip');
    fs.writeFileSync(zip, zipSync({ 'research/SKILL.md': strToU8(SKILL), '__MACOSX/x': strToU8('junk') }));
    const cand = await loadCandidate({ kind: 'path', path: zip }, p);
    expect(cand.items).toHaveLength(1);
    expect(cand.items[0]).toMatchObject({ ghost: true, fullName: 'research', description: 'Research the codebase before planning' });
    expect(cand.items[0].path.startsWith(path.join(cache, 'candidates'))).toBe(true);
  });

  it('zip-slip, absolute paths, symlinks and oversize archives are refused or skipped', async () => {
    const { p, cache } = setup();
    const d = tmp();
    const slip = path.join(d, 'slip.zip');
    fs.writeFileSync(slip, zipSync({ '../../evil.txt': strToU8('x'), 'SKILL.md': strToU8(SKILL) }));
    await expect(loadCandidate({ kind: 'path', path: slip }, p)).rejects.toThrow(/escapes/);
    const abs = path.join(d, 'abs.zip');
    fs.writeFileSync(abs, zipSync({ '/etc/evil.txt': strToU8('x') }));
    await expect(loadCandidate({ kind: 'path', path: abs }, p)).rejects.toThrow(/absolute/);
    expect(fs.existsSync(path.join(path.dirname(cache), 'evil.txt'))).toBe(false);

    const big = path.join(d, 'big.zip');
    fs.writeFileSync(big, zipSync({ 'SKILL.md': strToU8(SKILL), 'big.bin': new Uint8Array(51 * 1024 * 1024) }));
    await expect(loadCandidate({ kind: 'path', path: big }, p)).rejects.toThrow(/too large/);

    const z = zipSync({ 'SKILL.md': strToU8(SKILL), 'link': strToU8('/etc/passwd') });
    const buf = Buffer.from(z);
    for (let i = 0; i < buf.length - 46; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50 && buf.toString('utf8', i + 46, i + 50) === 'link') {
        buf.writeUInt16LE((3 << 8) | 20, i + 4);
        buf.writeUInt32LE((0o120777 << 16) >>> 0, i + 38);
      }
    }
    const sym = path.join(d, 'sym.zip');
    fs.writeFileSync(sym, buf);
    const cand = await loadCandidate({ kind: 'path', path: sym }, p);
    expect(cand.items).toHaveLength(1);
    const extracted = path.dirname(cand.items[0].path);
    expect(fs.existsSync(path.join(extracted, 'link'))).toBe(false);
  });

  it('plugin with a SessionStart hook and an MCP server: hook injects edge, masked MCP item', async () => {
    const { p, projects } = setup();
    const dir = path.join(tmp(), 'candplug');
    write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shiny' }));
    write(path.join(dir, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: Helps\n---\n');
    write(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo use the helper skill' }] }] } }));
    write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { api: { url: 'https://u:pw@x.dev/mcp?token=SECRET', headers: { Authorization: 'Bearer SECRET' } } } }));
    const cand = await loadCandidate({ kind: 'path', path: dir }, p);
    expect(cand.sources[0].id).toBe('candidate:shiny');
    expect(cand.items.every((i) => i.ghost && i.enabled && i.sourceId === 'candidate:shiny')).toBe(true);
    const hook = cand.items.find((i) => i.kind === 'hook')!;
    expect(hook).toBeTruthy();
    expect(cand.items.find((i) => i.kind === 'skill')!.fullName).toBe('shiny:helper');
    const mcp = cand.items.find((i) => i.kind === 'mcp-server')!;
    expect(mcp.mcp).toMatchObject({ endpoint: 'https://x.dev/mcp', headerKeys: ['Authorization'] });
    expect(JSON.stringify(cand)).not.toContain('SECRET');
    const m = await buildModel(p, projects.ringZero, { candidate: cand });
    expect(m.edges.some((e) => e.kind === 'injects' && e.from === hook.id)).toBe(true);
  });

  it('folder with neither skill nor plugin errors', async () => {
    const { p } = setup();
    const dir = tmp();
    write(path.join(dir, 'README.md'), 'x');
    await expect(loadCandidate({ kind: 'path', path: dir }, p)).rejects.toThrow(/no skill or plugin found/i);
  });

  it('git: clones --depth 1 into cacheDir only, reuses an existing clone, rejects bad URLs', async () => {
    const { p, cache } = setup();
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      write(path.join(args[4], 'SKILL.md'), SKILL);
    };
    const url = 'https://github.com/acme/research-skill.git';
    const cand = await loadCandidate({ kind: 'git', url }, p, git);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 4)).toEqual(['clone', '--depth', '1', url]);
    expect(calls[0][4].startsWith(path.join(cache, 'candidates') + path.sep)).toBe(true);
    expect(cand.items.map((i) => i.fullName)).toEqual(['research']);
    await loadCandidate({ kind: 'git', url }, p, git);
    expect(calls).toHaveLength(1);
    for (const bad of ['--upload-pack=touch /tmp/x', '-oProxyCommand=x', 'http://x.dev/r.git', '/local/path']) {
      await expect(loadCandidate({ kind: 'git', url: bad }, p, git)).rejects.toThrow(/Unsupported git URL/);
    }
    expect(calls).toHaveLength(1);
  });

  it('marketplace: installLocation is read locally; github plugin sources clone; unknowns error', async () => {
    const { p, cache } = setup();
    const mkt = path.join(tmp(), 'mkt');
    write(path.join(mkt, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'local-one', source: './plugins/local-one' }, { name: 'remote', source: { source: 'github', repo: 'acme/remote' } }] }));
    write(path.join(mkt, 'plugins', 'local-one', 'skills', 'research', 'SKILL.md'), SKILL);
    write(path.join(p.claudeDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ m1: { source: { source: 'github', repo: 'acme/mkt' }, installLocation: mkt } }));
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      write(path.join(args[4], 'skills', 'r2', 'SKILL.md'), '---\nname: r2\ndescription: Remote\n---\n');
    };
    const a = await loadCandidate({ kind: 'marketplace', marketplace: 'm1', plugin: 'local-one' }, p, git);
    expect(calls).toHaveLength(0);
    expect(a.sources[0].id).toBe('candidate:local-one');
    expect(a.items[0].fullName).toBe('local-one:research');
    const b = await loadCandidate({ kind: 'marketplace', marketplace: 'm1', plugin: 'remote' }, p, git);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 4)).toEqual(['clone', '--depth', '1', 'https://github.com/acme/remote.git']);
    expect(calls[0][4].startsWith(path.join(cache, 'candidates'))).toBe(true);
    expect(b.items[0].fullName).toBe('remote:r2');
    await expect(loadCandidate({ kind: 'marketplace', marketplace: 'nope', plugin: 'x' }, p, git)).rejects.toThrow(/Unknown marketplace/);
    await expect(loadCandidate({ kind: 'marketplace', marketplace: 'm1', plugin: 'nope' }, p, git)).rejects.toThrow(/not found/);
  });
});
