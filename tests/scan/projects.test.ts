import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureHome } from '../fixtures.js';
import { encodeProjectDir, listProjects } from '../../src/scan/projects.js';

describe('encodeProjectDir', () => {
  it('replaces non-alphanumerics with dashes', () => {
    expect(encodeProjectDir('/Users/a/repos/x.y')).toBe('-Users-a-repos-x-y');
  });
});

describe('listProjects', () => {
  it('includes existing projects, excludes deleted and temp paths', async () => {
    const { paths, projects } = fixtureHome();
    const list = await listProjects(paths);
    const ps = list.map((e) => e.path);
    expect(ps).toContain(projects.ringZero);
    expect(ps).toContain(projects.plain);
    expect(ps).not.toContain(projects.gone);
    expect(ps.some((x) => x.startsWith('/private/var/folders/xx'))).toBe(false);
    const rz = list.find((e) => e.path === projects.ringZero)!;
    expect(rz.name).toBe('ring-zero');
    expect(rz.lastUsed).not.toBeNull();
    expect(Date.now() - Date.parse(rz.lastUsed!)).toBeLessThan(60_000);
    expect(list.find((e) => e.path === projects.plain)!.lastUsed).toBeNull();
    expect(ps[0]).toBe(projects.ringZero); // sorted by lastUsed desc, null last
  });

  it('discovers projects from transcript cwd that .claude.json lacks', async () => {
    const { paths, projects } = fixtureHome();
    const extra = path.join(paths.home, 'repos', 'extra');
    fs.mkdirSync(extra, { recursive: true });
    const dir = path.join(paths.claudeDir, 'projects', encodeProjectDir(extra));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), `{"type":"x"}\nnot json "cwd"\n{"cwd":${JSON.stringify(extra)}}\n`);
    const list = await listProjects(paths);
    expect(list.map((e) => e.path)).toContain(extra);
    expect(list.map((e) => e.path)).toContain(projects.ringZero);
  });

  it('drops existing temp-dir projects outside home but keeps those under home', async () => {
    const { paths, projects } = fixtureHome();
    // A real directory under a temp prefix (/private/var/folders on macOS, /tmp on Linux), outside p.home.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-proj-')));
    try {
      expect(['/private/var/folders/', '/var/folders/', '/tmp/'].some((t) => tmp.startsWith(t))).toBe(true);
      const cj = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
      cj.projects[tmp] = {};
      fs.writeFileSync(paths.claudeJson, JSON.stringify(cj));
      const ps = (await listProjects(paths)).map((e) => e.path);
      expect(ps).not.toContain(tmp);
      expect(ps).toContain(projects.ringZero); // itself under a temp prefix, kept because it is under home
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
