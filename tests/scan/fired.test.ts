import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureHome } from '../fixtures.js';
import { pathsFor } from '../../src/paths.js';
import { encodeProjectDir } from '../../src/scan/projects.js';
import { applyFired, countFired } from '../../src/scan/fired.js';
import type { Item } from '../../src/model.js';

const DAY = 86_400_000;
const since = () => Date.now() - 30 * DAY;

function item(kind: Item['kind'], name: string, fullName = name): Item {
  return { id: `${kind}:${fullName}`, kind, name, fullName, sourceId: 's', path: '/x', description: '', enabled: true, decidedBy: null };
}

describe('countFired', () => {
  it('counts only transcripts inside the window', async () => {
    const { paths, projects } = fixtureHome();
    const c = await countFired(paths, projects.ringZero, { sinceMs: since(), excludeSessionIds: new Set() });
    expect(c.get('superpowers:brainstorming')).toEqual({ claude: 3, typed: 0 });
    expect(c.get('design')).toEqual({ claude: 0, typed: 1 });
    expect(c.get('Explore')).toEqual({ claude: 1, typed: 0 });
    expect(c.get('general-purpose')).toEqual({ claude: 1, typed: 0 });
  });

  it('excludes a session id', async () => {
    const { paths, projects } = fixtureHome();
    const c = await countFired(paths, projects.ringZero, { sinceMs: since(), excludeSessionIds: new Set(['recent-session']) });
    expect(c.size).toBe(0);
  });

  it('streams a 50,000-line transcript with a truncated last line', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fired-')));
    try {
      const proj = path.join(home, 'repos', 'big');
      const dir = path.join(home, '.claude', 'projects', encodeProjectDir(proj));
      fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
      const skill = JSON.stringify({ type: 'assistant', sessionId: 'big', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a:b' } }] } });
      const filler = JSON.stringify({ type: 'user', sessionId: 'big', message: { role: 'user', content: 'hello' } });
      const lines: string[] = [];
      for (let i = 0; i < 50_000; i++) lines.push(i % 2 === 0 ? skill : filler);
      fs.writeFileSync(path.join(dir, 'big.jsonl'), lines.join('\n') + '\n{"type":"assistant","message":{"content":[{"type":"tool_u');
      const sub = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a:b' } }] } });
      fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-1.jsonl'), sub + '\n');
      const t0 = Date.now();
      const c = await countFired(pathsFor(home), proj, { sinceMs: since(), excludeSessionIds: new Set() });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(c.get('a:b')).toEqual({ claude: 25_001, typed: 0 });
      const ex = await countFired(pathsFor(home), proj, { sinceMs: since(), excludeSessionIds: new Set(['sess']) });
      expect(ex.get('a:b')).toEqual({ claude: 25_000, typed: 0 });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('excludes a line whose sessionId field is excluded, and matches text blocks', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fired-')));
    try {
      const proj = path.join(home, 'p');
      const dir = path.join(home, '.claude', 'projects', encodeProjectDir(proj));
      fs.mkdirSync(dir, { recursive: true });
      const u = (sid: string) => JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: [{ type: 'text', text: '<command-name>/pl:cmd</command-name>' }] } });
      fs.writeFileSync(path.join(dir, 'f.jsonl'), [u('keep'), u('drop')].join('\n'));
      const c = await countFired(pathsFor(home), proj, { sinceMs: since(), excludeSessionIds: new Set(['drop']) });
      expect(c.get('pl:cmd')).toEqual({ claude: 0, typed: 1 });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('applyFired', () => {
  it('matches skills, agents and commands; leaves others without fired', () => {
    const counts = new Map([
      ['superpowers:brainstorming', { claude: 3, typed: 0 }],
      ['Explore', { claude: 1, typed: 0 }],
      ['design', { claude: 0, typed: 1 }],
      ['pl:cmd', { claude: 0, typed: 2 }],
    ]);
    const skill = item('skill', 'brainstorming', 'superpowers:brainstorming');
    const agent = item('agent', 'Explore');
    const cmd = item('command', 'design');
    const nsCmd = item('command', 'cmd', 'pl:cmd');
    const other = item('skill', 'unused');
    const hook = item('hook', 'design');
    applyFired([skill, agent, cmd, nsCmd, other, hook], counts);
    expect(skill.fired).toEqual({ claude: 3, typed: 0 });
    expect(agent.fired).toEqual({ claude: 1, typed: 0 });
    expect(cmd.fired).toEqual({ claude: 0, typed: 1 });
    expect(nsCmd.fired).toEqual({ claude: 0, typed: 2 });
    expect(other.fired).toBeUndefined();
    expect(hook.fired).toBeUndefined();
  });
});
