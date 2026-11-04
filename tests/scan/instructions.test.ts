import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { pathsFor } from '../../src/paths.js';
import { findImports, scanInstructions } from '../../src/scan/instructions.js';

describe('scanInstructions', () => {
  it('finds project instructions, imports, rules, nested conditionals and memory', async () => {
    const { paths, projects } = fixtureHome();
    const items = await scanInstructions(paths, projects.ringZero);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['CLAUDE.md']?.sourceId).toBe('project');
    expect(byName['CLAUDE.md']?.description).toBe('See @docs/extra.md for more.');
    expect(byName['docs/extra.md']).toBeDefined();
    expect(byName['CLAUDE.local.md']).toBeDefined();
    expect(byName['.claude/rules/style.md']).toBeDefined();
    expect(byName['src/game/CLAUDE.md']?.conditional).toBe(true);
    expect(byName['CLAUDE.md']?.conditional).toBeUndefined();
    const mem = items.find((i) => i.kind === 'memory');
    expect(mem?.description).toBe('1 memory files');
    expect(mem?.sourceId).toBe('user');
  });

  it('does not throw for a project with nothing', async () => {
    const { paths, projects } = fixtureHome();
    const items = await scanInstructions(paths, projects.plain);
    expect(items.filter((i) => i.kind === 'memory')).toEqual([]);
    expect(items.filter((i) => i.sourceId === 'project' && (i.name.includes('rules') || i.conditional)).length).toBe(0);
    expect(items.filter((i) => i.sourceId === 'project').map((i) => i.name).filter((n) => !n.startsWith('..'))).toEqual([]);
  });

  it('ignores imports in code and skips missing targets', () => {
    expect(findImports('a @x.md `@y.md`\n```\n@z.md\n```\nmail me@a.com @~/q.md.')).toEqual(['x.md', '~/q.md']);
  });

  describe('temp-dir cases', () => {
    function setup() {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-instr-')));
      const proj = path.join(home, 'work', 'proj');
      fs.mkdirSync(proj, { recursive: true });
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      return { home, proj, p: pathsFor(home) };
    }
    const w = (f: string, t: string) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    };

    it('attributes ~/.claude/CLAUDE.md to user and ancestors to project with ../ names', async () => {
      const { home, proj, p } = setup();
      w(path.join(home, '.claude', 'CLAUDE.md'), '# U\nglobal');
      w(path.join(home, 'work', 'CLAUDE.md'), '# A\nancestor');
      const items = await scanInstructions(p, proj);
      const u = items.find((i) => i.fullName === path.join(home, '.claude', 'CLAUDE.md'))!;
      expect(u.sourceId).toBe('user');
      expect(u.name).toBe('CLAUDE.md');
      const a = items.find((i) => i.fullName === path.join(home, 'work', 'CLAUDE.md'))!;
      expect(a.sourceId).toBe('project');
      expect(a.name).toBe(path.join('..', 'CLAUDE.md'));
    });

    it('resolves @~/ imports against home, skips missing targets, and survives cycles', async () => {
      const { home, proj, p } = setup();
      w(path.join(home, 'shared.md'), '# S\nshared');
      w(path.join(proj, 'CLAUDE.md'), '# P\n@~/shared.md @nope.md @b.md');
      w(path.join(proj, 'b.md'), 'b imports @CLAUDE.md');
      const items = await scanInstructions(p, proj);
      expect(items.map((i) => i.fullName)).toEqual(expect.arrayContaining([path.join(home, 'shared.md'), path.join(proj, 'b.md')]));
      expect(items.some((i) => i.fullName.endsWith('nope.md'))).toBe(false);
      expect(items.filter((i) => i.fullName === path.join(proj, 'CLAUDE.md')).length).toBe(1);
    });

    it('skips node_modules for nested CLAUDE.md and caps description at 200 chars', async () => {
      const { proj, p } = setup();
      w(path.join(proj, 'CLAUDE.md'), '# P\n\n' + 'x'.repeat(300));
      w(path.join(proj, 'node_modules', 'pkg', 'CLAUDE.md'), '# N');
      w(path.join(proj, 'src', 'CLAUDE.md'), '# S');
      const items = await scanInstructions(p, proj);
      expect(items.some((i) => i.fullName.includes('node_modules'))).toBe(false);
      expect(items.some((i) => i.name === path.join('src', 'CLAUDE.md') && i.conditional)).toBe(true);
      expect(items.find((i) => i.name === 'CLAUDE.md')!.description).toHaveLength(200);
    });
  });
});
