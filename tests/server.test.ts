import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { fixtureHome } from './fixtures.js';
import type { AtlasModel } from '../src/model.js';

type Started = Awaited<ReturnType<typeof startServer>>;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const MCP_OUT = 'ctx7: https://example.com/mcp?key=SECRET (HTTP) - ✓ Connected\nclaude.ai Gmail: https://gmail.example/mcp - ✗ Failed to connect\n';

async function boot(runners: Parameters<typeof startServer>[0]['runners'] = {}) {
  const fx = fixtureHome();
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html>atlas</html>');
  fs.writeFileSync(path.join(webDir, 'app.js'), 'x');
  fs.writeFileSync(path.join(path.dirname(webDir), 'atlas-secret.txt'), 'secret');
  const s: Started = await startServer({ paths: fx.paths, port: 0, webDir, runners });
  closers.push(() => s.close());
  const api = (p: string, init: RequestInit = {}) => {
    const sep = p.includes('?') ? '&' : '?';
    return fetch(`${s.url}${p.replace(/^\//, '')}${sep}t=${s.token}`, init);
  };
  return { s, fx, webDir, api };
}

describe('server', () => {
  it('requires the token on /api', async () => {
    const { s, fx, api } = await boot();
    expect((await fetch(`${s.url}api/projects`)).status).toBe(401);
    expect((await fetch(`${s.url}api/projects?t=nope`)).status).toBe(401);
    const hdr = await fetch(`${s.url}api/projects`, { headers: { 'x-atlas-token': s.token } });
    expect(hdr.status).toBe(200);
    const res = await api('/api/projects');
    expect(res.status).toBe(200);
    const list = (await res.json()) as { path: string }[];
    expect(list.map((p) => p.path)).toContain(fx.projects.ringZero);
  });

  it('rejects a foreign Host with 403 before checking the token', async () => {
    const { s } = await boot();
    const port = Number(new URL(s.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/projects?t=${s.token}`, headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
    const ok = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/projects?t=${s.token}`, headers: { Host: `localhost:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(ok).toBe(200);
  });

  it('listens on 127.0.0.1 only with a 64-hex token', async () => {
    const { s } = await boot();
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(s.address.address).toBe('127.0.0.1');
  });

  it('serves model, 404 for unknown project, 400 without one', async () => {
    const { fx, api } = await boot();
    const res = await api(`/api/model?project=${encodeURIComponent(fx.projects.ringZero)}`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as AtlasModel;
    expect(m.project).toBe(fx.projects.ringZero);
    expect(m.items.length).toBeGreaterThan(0);
    expect((await api('/api/model?project=/no/such/dir-xyz')).status).toBe(404);
    expect((await api('/api/model')).status).toBe(400);
  });

  it('caches the model until rescan', async () => {
    const { fx, api } = await boot();
    const q = `?project=${encodeURIComponent(fx.projects.ringZero)}`;
    const a = (await (await api(`/api/model${q}`)).json()) as AtlasModel;
    await new Promise((r) => setTimeout(r, 15));
    const b = (await (await api(`/api/model${q}`)).json()) as AtlasModel;
    expect(b.scannedAt).toBe(a.scannedAt);
    const c = (await (await api(`/api/rescan${q}`, { method: 'POST' })).json()) as AtlasModel;
    expect(c.scannedAt).not.toBe(a.scannedAt);
    const d = (await (await api(`/api/model${q}`)).json()) as AtlasModel;
    expect(d.scannedAt).toBe(c.scannedAt);
  });

  it('mcp-live uses the injected runner and expands connectors', async () => {
    const calls: string[] = [];
    const { fx, api } = await boot({ mcpList: async (dir) => (calls.push(dir), MCP_OUT) });
    const q = `?project=${encodeURIComponent(fx.projects.ringZero)}`;
    const res = await api(`/api/mcp-live${q}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([fx.projects.ringZero]);
    const m = (await res.json()) as AtlasModel;
    const mcp = m.items.filter((i) => i.kind === 'mcp-server');
    expect(mcp.find((i) => i.id === 'connectors:claude.ai')).toBeUndefined();
    const gmail = mcp.find((i) => i.name === 'claude.ai Gmail')!;
    expect(gmail.sourceId).toBe('connectors');
    expect(gmail.mcp?.live).toBe('failed');
    expect(m.edges.some((e) => e.kind === 'provides' && e.to === gmail.id)).toBe(true);
    for (const i of mcp) expect(i.mcp?.live).toBeDefined();
    expect(JSON.stringify(m)).not.toContain('SECRET');
    const again = (await (await api(`/api/model${q}`)).json()) as AtlasModel;
    expect(again.items.find((i) => i.name === 'claude.ai Gmail')).toBeDefined();
  });

  it('candidate validates input and passes the ghosts', async () => {
    const { fx, api } = await boot({ git: async () => { throw new Error('no git in tests'); } });
    const post = (body: unknown) => api('/api/candidate', { method: 'POST', body: JSON.stringify(body) });
    expect((await post({ project: fx.projects.ringZero, input: { kind: 'bogus' } })).status).toBe(400);
    expect((await post({ project: fx.projects.ringZero, input: { kind: 'git' } })).status).toBe(400);
    expect((await post({ input: { kind: 'path', path: '/x' } })).status).toBe(400);
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cand-'));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: ghosty\ndescription: A ghost skill\n---\nbody');
    const res = await post({ project: fx.projects.ringZero, input: { kind: 'path', path: path.join(skillDir, 'SKILL.md') } });
    expect(res.status).toBe(200);
    const m = (await res.json()) as AtlasModel;
    expect(m.items.some((i) => i.ghost && i.name === 'ghosty')).toBe(true);
    const plain = (await (await api(`/api/model?project=${encodeURIComponent(fx.projects.ringZero)}`)).json()) as AtlasModel;
    expect(plain.items.some((i) => i.ghost)).toBe(false);
  });

  it('judge capability and 409 when unavailable', async () => {
    const calls: string[][] = [];
    const { fx, api } = await boot({ claude: async (a) => (calls.push(a), ''), env: {} });
    const cap = await (await api('/api/judge/capability')).json();
    expect(cap.available).toBe(false);
    await api('/api/judge/capability');
    const res = await api(`/api/judge?project=${encodeURIComponent(fx.projects.ringZero)}`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).available).toBe(false);
  });

  it('body limit, bad JSON, routes, methods', async () => {
    const { fx, api } = await boot();
    const big = await api('/api/candidate', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(1_100_000) }) });
    expect(big.status).toBe(413);
    expect((await api('/api/candidate', { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await api('/api/nothing')).status).toBe(404);
    expect((await api('/api/projects', { method: 'POST' })).status).toBe(405);
    expect((await api(`/api/rescan?project=${encodeURIComponent(fx.projects.ringZero)}`)).status).toBe(405);
  });

  it('serves static files without a token, blocks traversal', async () => {
    const { s } = await boot();
    const root = await fetch(s.url);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('x-content-type-options')).toBe('nosniff');
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await root.text()).toContain('atlas');
    const js = await fetch(`${s.url}app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    const port = Number(new URL(s.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/..%2Fatlas-secret.txt', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(404);
    expect((await fetch(`${s.url}missing.js`)).status).toBe(404);
  });
});
