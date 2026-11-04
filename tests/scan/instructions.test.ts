import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
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
  });

  it('ignores imports in code and skips missing targets', () => {
    expect(findImports('a @x.md `@y.md`\n```\n@z.md\n```\nmail me@a.com @~/q.md.')).toEqual(['x.md', '~/q.md']);
  });
});
