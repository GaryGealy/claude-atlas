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
    expect(path.isAbsolute(r.items[0].path) || r.items[0].path.startsWith('plugin:')).toBe(true);
  });
});

describe('sanitizeEndpoint', () => {
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
