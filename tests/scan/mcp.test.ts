import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { fixtureHome } from '../fixtures.js';
import { liveMcpStatus, parseMcpList, sanitizeEndpoint, scanMcp } from '../../src/scan/mcp.js';

vi.mock('node:child_process');
vi.mock('child_process');

const SAMPLE = `Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
context7: https://mcp.context7.com/mcp (HTTP) - ✗ Failed to connect
`;

describe('scanMcp', () => {
  it('masks secrets, keeps env names, handles approval, spawns nothing', async () => {
    const { paths, projects } = fixtureHome();
    const r = await scanMcp(paths, projects.ringZero, []);
    const get = (id: string) => r.items.find((i) => i.id === id)!;
    expect(get('mcp-server:mcp:user:context7').mcp!.endpoint).toBe('https://mcp.context7.com/mcp');
    expect(get('mcp-server:mcp:local:local1').mcp!.envKeys).toEqual(['API_TOKEN']);
    expect(get('mcp-server:mcp:local:local1').mcp!.endpoint).toBe('node server.js');
    expect(get('mcp-server:project:shared').mcp!.approved).toBe(true);
    expect(get('mcp-server:project:unapproved').mcp!.approved).toBeNull();
    expect(get('mcp-server:project:unapproved').enabled).toBe(true);
    const s = JSON.stringify(r);
    expect(s).not.toContain('SECRET123');
    expect(s).not.toContain('SECRET456');
    expect(r.sources.map((x) => x.id)).toEqual(['mcp:user', 'mcp:local', 'connectors']);
    expect(r.items.filter((i) => i.sourceId === 'connectors').map((i) => i.name)).toEqual(['claude.ai connectors (not checked)']);
    for (const mod of [cp as Record<string, unknown>]) {
      for (const fn of Object.values(mod)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('disabled .mcp.json server is approved:false, enabled:false, decided by ~/.claude.json; enableAll approves', async () => {
    const { paths, projects } = fixtureHome();
    const j = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
    j.projects[projects.ringZero].disabledMcpjsonServers = ['unapproved'];
    fs.writeFileSync(paths.claudeJson, JSON.stringify(j));
    let r = await scanMcp(paths, projects.ringZero, []);
    const u = r.items.find((i) => i.id === 'mcp-server:project:unapproved')!;
    expect(u.mcp!.approved).toBe(false);
    expect(u.enabled).toBe(false);
    expect(u.decidedBy).toBe(paths.claudeJson);
    j.projects[projects.ringZero].disabledMcpjsonServers = [];
    j.projects[projects.ringZero].enableAllProjectMcpServers = true;
    fs.writeFileSync(paths.claudeJson, JSON.stringify(j));
    r = await scanMcp(paths, projects.ringZero, []);
    expect(r.items.find((i) => i.id === 'mcp-server:project:unapproved')!.mcp!.approved).toBe(true);
  });

  it('plain project with no servers emits only connectors; plugin MCP attaches to its source', async () => {
    const { paths, projects } = fixtureHome();
    const j = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
    delete j.mcpServers;
    fs.writeFileSync(paths.claudeJson, JSON.stringify(j));
    const r = await scanMcp(paths, projects.plain, [
      { sourceId: 'plugin:sp', json: { mcpServers: { x: { url: 'https://u:pw@h.io/m?k=SECRET789#f', headers: { Authorization: 'Bearer SECRET789' } } } } },
    ]);
    expect(r.sources.map((x) => x.id)).toEqual(['connectors']);
    const x = r.items.find((i) => i.id === 'mcp-server:plugin:sp:x')!;
    expect(x.mcp).toMatchObject({ transport: 'http', endpoint: 'https://h.io/m', headerKeys: ['Authorization'] });
    expect(JSON.stringify(r)).not.toContain('SECRET789');
    expect(x.path).toBe('');
  });
});

describe('stdio arg redaction and settings-layer approvals', () => {
  it('redacts secret args but keeps flag names', async () => {
    const { paths, projects } = fixtureHome();
    const j = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
    j.mcpServers.s = { command: 'npx', args: ['srv', '--api-key', 'SECRET1', '--token=SECRET2', 'API_KEY=SECRET3', 'Authorization: Bearer SECRET4', '--port', '80'] };
    fs.writeFileSync(paths.claudeJson, JSON.stringify(j));
    const r = await scanMcp(paths, projects.ringZero, []);
    const s = JSON.stringify(r);
    for (const x of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4']) expect(s).not.toContain(x);
    expect(r.items.find((i) => i.id === 'mcp-server:mcp:user:s')!.mcp!.endpoint).toBe(
      'npx srv --api-key *** --token=*** API_KEY=*** Authorization: Bearer *** --port 80',
    );
  });

  it('masks header values (-H, --header, --header=, single arg) and credential-like URL path segments', async () => {
    const { paths, projects } = fixtureHome();
    const j = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
    j.mcpServers.h = { command: 'npx', args: ['mcp-remote', 'https://mcp.example.com/v1/AbCdEf0123456789XyZ0/sse', '-H', 'X-API-Key: HSECRET1', '--header', 'X-Org: HSECRET2', '--header=X-Token=HSECRET3', '--header=X-Auth: HSECRET4'] };
    j.mcpServers.u = { type: 'http', url: 'https://mcp.example.com/team/AbCdEf0123456789XyZ0/mcp?x=1' };
    fs.writeFileSync(paths.claudeJson, JSON.stringify(j));
    const r = await scanMcp(paths, projects.ringZero, []);
    const s = JSON.stringify(r);
    for (const x of ['HSECRET1', 'HSECRET2', 'HSECRET3', 'HSECRET4', 'AbCdEf0123456789XyZ0']) expect(s).not.toContain(x);
    expect(r.items.find((i) => i.id === 'mcp-server:mcp:user:h')!.mcp!.endpoint).toBe(
      'npx mcp-remote https://mcp.example.com/v1/***/sse -H X-API-Key: *** --header X-Org: *** --header=X-Token=*** --header=X-Auth: ***',
    );
    expect(r.items.find((i) => i.id === 'mcp-server:mcp:user:u')!.mcp!.endpoint).toBe('https://mcp.example.com/team/***/mcp');
  });

  it('approval from project settings.local.json, decidedBy points there; disabled in another layer wins', async () => {
    const { paths, projects } = fixtureHome();
    const dir = path.join(projects.ringZero, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, 'settings.local.json');
    fs.writeFileSync(local, JSON.stringify({ enabledMcpjsonServers: ['unapproved'], enableAllProjectMcpServers: false }));
    let r = await scanMcp(paths, projects.ringZero, []);
    let u = r.items.find((i) => i.id === 'mcp-server:project:unapproved')!;
    expect(u.mcp!.approved).toBe(true);
    expect(u.decidedBy).toBe(local);
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    const userS = path.join(paths.claudeDir, 'settings.json');
    fs.writeFileSync(userS, JSON.stringify({ disabledMcpjsonServers: ['unapproved'] }));
    r = await scanMcp(paths, projects.ringZero, []);
    u = r.items.find((i) => i.id === 'mcp-server:project:unapproved')!;
    expect(u.mcp!.approved).toBe(false);
    expect(u.enabled).toBe(false);
    expect(u.decidedBy).toBe(userS);
  });
});

describe('sanitizeEndpoint', () => {
  it('strips URLs embedded in flags and quotes', () => {
    expect(sanitizeEndpoint('x --url=https://h/x?token=T')).toBe('x --url=https://h/x');
    expect(sanitizeEndpoint('x "https://h/x?k=v"')).toBe('x "https://h/x"');
    expect(sanitizeEndpoint("x 'https://u:p@h/x?k=v#f'")).toBe("x 'https://h/x'");
  });
  it('strips userinfo, query, fragment, also in command args', () => {
    expect(sanitizeEndpoint('https://u:p@h.io/a?k=v#f')).toBe('https://h.io/a');
    expect(sanitizeEndpoint('npx mcp-remote https://h.io/a?token=T')).toBe('npx mcp-remote https://h.io/a');
    expect(sanitizeEndpoint('node s.js')).toBe('node s.js');
  });
});

describe('parseMcpList / liveMcpStatus', () => {
  it('parses connector names with spaces/dots, suffixes and statuses', () => {
    expect(parseMcpList(SAMPLE)).toEqual([
      { name: 'claude.ai Gmail', endpoint: 'https://gmailmcp.googleapis.com/mcp/v1', status: 'connected' },
      { name: 'context7', endpoint: 'https://mcp.context7.com/mcp', status: 'failed' },
    ]);
  });
  it('tolerates variants and unknown status', () => {
    const r = parseMcpList('a: node x.js - ✓ Connected\nb: https://h/s (SSE) - ✘ Failed\nc: foo - ! Needs authentication\njunk line');
    expect(r.map((e) => e.status)).toEqual(['connected', 'failed', 'unknown']);
    expect(r[1].endpoint).toBe('https://h/s');
  });
  it('liveMcpStatus uses the injected runner', async () => {
    const run = vi.fn().mockResolvedValue(SAMPLE);
    expect(await liveMcpStatus('/p', run)).toHaveLength(2);
    expect(run).toHaveBeenCalledWith('/p');
  });
});
