import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureHome } from '../fixtures.js';
import { REQUIRED_FLAGS, judgePairs, loadJudgeSessions, makeRunner, probeJudge, type JudgeRun } from '../../src/analyze/judge.js';
import type { Edge, Item } from '../../src/model.js';

const HELP = `Options:\n  --bare  x\n  --setting-sources <s>  x\n  --strict-mcp-config  x\n  --no-session-persistence  x\n  --disable-slash-commands  x\n`;
const KEY = { ANTHROPIC_API_KEY: 'k' };
const item = (id: string, description: string) => ({ id, description }) as Item;
const edge: Edge = { id: 'e', kind: 'competes', from: 'a', to: 'b', competes: { reasons: [], score: 1, strength: 2, tilt: [] } };
const mk = () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  return { cacheDir, paths: { ...fixtureHome().paths, cacheDir } };
};
const items = [item('a', 'plan things'), item('b', 'make plans')];

describe('probeJudge', () => {
  it('names a missing flag', async () => {
    const cap = await probeJudge(async () => HELP.replace('--no-session-persistence', ''), KEY);
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain('--no-session-persistence');
  });
  it('is unavailable without bare-mode auth, naming ANTHROPIC_API_KEY', async () => {
    const cap = await probeJudge(async () => HELP, {});
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain('ANTHROPIC_API_KEY');
    expect((await probeJudge(async () => HELP, { CLAUDE_CODE_USE_BEDROCK: '1' })).available).toBe(true);
  });
  it('builds args with required and present optional flags', async () => {
    const run = vi.fn(async () => HELP);
    const cap = await probeJudge(run, KEY);
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
    const cap = await probeJudge(async () => HELP, KEY);
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
    const cap = await probeJudge(async () => HELP, KEY);
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
  it('treats an is_error envelope as failure, not cached', async () => {
    const { cacheDir, paths } = mk();
    const cap = await probeJudge(async () => HELP, KEY);
    const e1 = structuredClone(edge);
    await judgePairs([e1], items, paths, cap, async () => JSON.stringify({ is_error: true, result: '{"same":true,"why":"x"}' }));
    expect(e1.competes!.judge).toBeUndefined();
    expect(() => readFileSync(path.join(cacheDir, 'judge.json'))).toThrow();
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

describe('runClaude', () => {
  it('closes stdin so a stdin-reading binary finishes', async () => {
    const bin = path.join(mkdtempSync(path.join(os.tmpdir(), 'stub-')), 'stub.sh');
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho stub-out\n');
    chmodSync(bin, 0o755);
    const t = Date.now();
    expect((await makeRunner(bin)(['x'])).trim()).toBe('stub-out');
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
