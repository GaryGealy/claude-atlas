import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { scanLocal } from '../../src/scan/local.js';
import { scanPlugins } from '../../src/scan/plugins.js';
import { resolveSettings } from '../../src/scan/settings.js';
import { collectTemplates, traceItems } from '../../src/scan/trace.js';
import { cosine, tokens } from '../../src/util/text.js';

async function traced() {
  const { paths, projects } = fixtureHome();
  const s = await resolveSettings(paths, projects.ringZero);
  const r = await scanLocal(paths, projects.ringZero, s, () => {});
  const templates = await collectTemplates(paths);
  return { paths, s, items: r.items, templates, out: await traceItems(r.items, templates) };
}

describe('text utils', () => {
  it('tokens lowercases, splits on non-alphanumerics and drops stopwords', () => {
    expect(tokens('The Quick-Brown fox, and THE dog!')).toEqual(['quick', 'brown', 'fox', 'dog']);
  });
  it('cosine of identical text rounds to 1, disjoint is 0, empty is 0', () => {
    expect(Math.round(cosine('alpha beta gamma beta', 'alpha beta gamma beta') * 100) / 100).toBe(1);
    expect(cosine('alpha beta', 'gamma delta')).toBe(0);
    expect(cosine('', 'alpha')).toBe(0);
  });
});

describe('collectTemplates', () => {
  it('finds nested templates, not top-level plugin components', async () => {
    const { paths, templates } = await traced();
    const names = templates.map((t) => `${t.plugin}@${t.version}:${t.relPath}`);
    expect(names).toContain('rpi@5.0.0:skills/setup/reference/skills/design/SKILL.md');
    expect(names).toContain('rpi@5.0.0:skills/setup/reference/skills/create-plan/SKILL.md');
    expect(templates.some((t) => /^skills\/setup\/SKILL\.md$/.test(t.relPath))).toBe(false);
    expect(fs.existsSync(paths.claudeDir)).toBe(true);
  });

  it('recognises agents/commands dirs nested in templates but not top-level ones', async () => {
    const { paths } = fixtureHome();
    const v = path.join(paths.claudeDir, 'plugins', 'cache', 'm', 'p', '1.0.0');
    for (const f of ['agents/top.md', 'commands/topc.md', 'templates/agents/helper.md', 'templates/commands/go.md', 'templates/loose/SKILL.md', 'node_modules/x/agents/bad.md']) {
      fs.mkdirSync(path.dirname(path.join(v, f)), { recursive: true });
      fs.writeFileSync(path.join(v, f), `# ${f}`);
    }
    const rel = (await collectTemplates(paths)).filter((t) => t.plugin === 'p').map((t) => t.relPath).sort();
    expect(rel).toEqual(['templates/agents/helper.md', 'templates/commands/go.md', 'templates/loose/SKILL.md']);
  });
});

describe('traceItems', () => {
  const proj = (items: { sourceId: string; kind: string; name: string; tracedFrom?: unknown }[], n: string) =>
    items.find((i) => i.sourceId === 'project' && i.kind === 'skill' && i.name === n);

  it('identical skill traces with similarity 1 and edited false', async () => {
    const { out } = await traced();
    expect(proj(out, 'design')?.tracedFrom).toEqual({ plugin: 'rpi', version: '5.0.0', similarity: 1, edited: false });
  });
  it('edited skill is flagged with similarity between 0.6 and 1', async () => {
    const { out } = await traced();
    const t = proj(out, 'create-plan')?.tracedFrom as { similarity: number; edited: boolean };
    expect(t.edited).toBe(true);
    expect(t.similarity).toBeGreaterThanOrEqual(0.6);
    expect(t.similarity).toBeLessThan(1);
  });
  it('unique skill is untraced and non-project items are untouched', async () => {
    const { out, items } = await traced();
    expect(proj(out, 'guide')?.tracedFrom).toBeUndefined();
    items.forEach((it, i) => {
      if (it.sourceId !== 'project') expect(out[i]).toBe(it);
    });
  });
  it('does not match across kinds', async () => {
    const { templates, items } = await traced();
    const asAgent = items.map((i) => (i.sourceId === 'project' && i.name === 'design' ? { ...i, kind: 'agent' as const } : i));
    const out = await traceItems(asAgent, templates);
    expect(out.find((i) => i.kind === 'agent' && i.name === 'design')?.tracedFrom).toBeUndefined();
  });
});

describe('templates vs scanPlugins', () => {
  it('template files do not appear as plugin items', async () => {
    const { paths, s } = await traced();
    const r = await scanPlugins(paths, null, s, () => {});
    expect(r.items.some((i) => i.path.includes(`${path.sep}reference${path.sep}`))).toBe(false);
  });
});
