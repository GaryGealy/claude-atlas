import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { REQUIRED_FLAGS, judgePairs, loadJudgeSessions, probeJudge, type JudgeRun } from '../../src/analyze/judge.js';
import type { Edge, Item } from '../../src/model.js';

const HELP = `Options:\n  --bare  x\n  --setting-sources <s>  x\n  --strict-mcp-config  x\n  --no-session-persistence  x\n  --disable-slash-commands  x\n`;
const item = (id: string, description: string) => ({ id, description }) as Item;
const edge: Edge = { id: 'e', kind: 'competes', from: 'a', to: 'b', competes: { reasons: [], score: 1, tilt: [] } };
const mk = () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  return { cacheDir, paths: { ...fixtureHome().paths, cacheDir } };
};
const items = [item('a', 'plan things'), item('b', 'make plans')];

describe('probeJudge', () => {
  it('names a missing flag', async () => {
    const cap = await probeJudge(async () => HELP.replace('--no-session-persistence', ''));
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain('--no-session-persistence');
  });
  it('builds args with required and present optional flags', async () => {
    const run = vi.fn(async () => HELP);
    const cap = await probeJudge(run);
    expect(run).toHaveBeenCalledWith(['--help']);
    expect(cap.available).toBe(true);
    for (const f of REQUIRED_FLAGS) expect(cap.args).toContain(f);
    expect(cap.args).toContain('-p');
    expect(cap.args).toContain('--disable-slash-commands');
    expect(cap.args).not.toContain('--restricted');
  });
});

describe('judgePairs', () => {
  it('runs isolated in scratch, parses fenced reply, caches, records session', async () => {
    const { cacheDir, paths } = mk();
    const cap = await probeJudge(async () => HELP);
    const run = vi.fn<JudgeRun>(async () =>
      JSON.stringify({ session_id: 's1', result: '```json\n{"same": true, "why": "both plan"}\n```' }));
    const e1 = structuredClone(edge);
    await judgePairs([e1], items, paths, cap, run);
    expect(e1.competes!.judge).toEqual({ same: true, why: 'both plan' });
    expect(run.mock.calls[0][1]?.cwd).toBe(path.join(cacheDir, 'judge-scratch'));
    for (const f of REQUIRED_FLAGS) expect(run.mock.calls[0][0]).toContain(f);
    expect(run.mock.calls[0][0]).toContain('-p');
    expect(await loadJudgeSessions(path.join(cacheDir, 'judge-sessions.json'))).toEqual(new Set(['s1']));

    const e2: Edge = { ...structuredClone(edge), from: 'b', to: 'a' };
    await judgePairs([e2], items, paths, cap, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(e2.competes!.judge?.same).toBe(true);
    expect(JSON.parse(readFileSync(path.join(cacheDir, 'judge.json'), 'utf8'))).toBeTruthy();
  });
  it('leaves bad replies and failures unset and uncached', async () => {
    const { cacheDir, paths } = mk();
    const cap = await probeJudge(async () => HELP);
    const e1 = structuredClone(edge);
    await judgePairs([e1], items, paths, cap, async () => JSON.stringify({ result: 'no idea' }));
    await judgePairs([e1], items, paths, cap, async () => { throw new Error('boom'); });
    expect(e1.competes!.judge).toBeUndefined();
    const run = vi.fn<JudgeRun>(async () => '{"result":"{\\"same\\":false,\\"why\\":\\"x\\"}"}');
    await judgePairs([e1], items, paths, cap, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(e1.competes!.judge?.same).toBe(false);
    void cacheDir;
  });
  it('does nothing when unavailable', async () => {
    const { paths } = mk();
    const run = vi.fn<JudgeRun>();
    const e1 = structuredClone(edge);
    await judgePairs([e1], items, paths, { available: false, reason: 'x', args: [] }, run);
    expect(run).not.toHaveBeenCalled();
    expect(e1.competes!.judge).toBeUndefined();
  });
});
