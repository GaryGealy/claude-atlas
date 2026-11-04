import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import type { Item, Source } from '../model.js';
import { readText } from '../util/fs.js';

type Mcp = NonNullable<Item['mcp']>;
type Live = NonNullable<Mcp['live']>;
export type McpListEntry = { name: string; endpoint: string; status: Live };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const SECRET_NAME = /key|token|secret|password|passwd|auth|bearer|credential/i;

/** Strips query, fragment and userinfo from every URL in the string, and redacts Bearer/Basic values. */
export function sanitizeEndpoint(urlOrCommand: string): string {
  return urlOrCommand.replace(URL_RE, sanitizeUrl).replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***');
}

/** Redacts secret-looking values in stdio args: flag values, NAME=value, Bearer/Basic. */
function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const a of args) {
    if (redactNext && !a.startsWith('-')) {
      out.push('***');
      redactNext = false;
      continue;
    }
    redactNext = false;
    const m = /^(-{1,2}[^=\s]+)(=)(.*)$/.exec(a) ?? /^([A-Za-z_][\w.-]*)(=)(.*)$/.exec(a);
    if (m && SECRET_NAME.test(m[1])) out.push(`${m[1]}=***`);
    else if (/^-{1,2}[^=\s]+$/.test(a) && SECRET_NAME.test(a)) {
      out.push(a);
      redactNext = true;
    } else out.push(a);
  }
  return out;
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function keys(v: unknown): string[] {
  return isObj(v) ? Object.keys(v) : [];
}

function toItem(sourceId: string, name: string, cfg: unknown, file: string): Item {
  const c = isObj(cfg) ? cfg : {};
  const url = typeof c.url === 'string' ? c.url : null;
  const command = typeof c.command === 'string' ? c.command : null;
  const type = c.type;
  const transport: Mcp['transport'] =
    type === 'stdio' || type === 'http' || type === 'sse' ? type : url ? 'http' : command ? 'stdio' : 'unknown';
  const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [];
  const raw = url ?? (command ? [command, ...redactArgs(args)].join(' ') : '');
  const endpoint = sanitizeEndpoint(raw);
  return {
    id: `mcp-server:${sourceId}:${name}`,
    kind: 'mcp-server',
    name,
    fullName: name,
    sourceId,
    path: file,
    description: endpoint,
    enabled: true,
    decidedBy: null,
    mcp: { transport, endpoint, envKeys: keys(c.env), headerKeys: keys(c.headers), approved: null },
  };
}

function serversOf(json: unknown): [string, unknown][] {
  return isObj(json) && isObj(json.mcpServers) ? Object.entries(json.mcpServers) : [];
}

type Approvals = { enableAll: string | null; enabled: Map<string, string>; disabled: Map<string, string> };

/** Approval keys live in ~/.claude.json projects[dir] and in every settings layer; disabled anywhere wins. */
async function readApprovals(p: ClaudePaths, projectDir: string, proj: unknown): Promise<Approvals> {
  const layers: [string, unknown][] = [[p.claudeJson, proj]];
  for (const f of [
    path.join(p.claudeDir, 'settings.json'),
    path.join(p.claudeDir, 'settings.local.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(p.managedDir, 'managed-settings.json'),
  ])
    layers.push([f, await readJson(f)]);
  const ap: Approvals = { enableAll: null, enabled: new Map(), disabled: new Map() };
  for (const [file, j] of layers) {
    if (!isObj(j)) continue;
    if (j.enableAllProjectMcpServers === true && !ap.enableAll) ap.enableAll = file;
    for (const n of strList(j.enabledMcpjsonServers)) if (!ap.enabled.has(n)) ap.enabled.set(n, file);
    for (const n of strList(j.disabledMcpjsonServers)) if (!ap.disabled.has(n)) ap.disabled.set(n, file);
  }
  return ap;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function scanMcp(
  p: ClaudePaths,
  projectDir: string,
  pluginMcp: { sourceId: string; json: unknown }[],
): Promise<{ sources: Source[]; items: Item[] }> {
  const sources: Source[] = [];
  const items: Item[] = [];
  const cj = await readJson(p.claudeJson);
  const proj = isObj(cj) && isObj(cj.projects) && isObj(cj.projects[projectDir]) ? cj.projects[projectDir] : {};

  const userServers = serversOf(cj);
  if (userServers.length) {
    sources.push({ id: 'mcp:user', kind: 'mcp', label: 'MCP (user)', enabled: true, decidedBy: null });
    for (const [n, c] of userServers) items.push(toItem('mcp:user', n, c, p.claudeJson));
  }
  const localServers = serversOf(proj);
  if (localServers.length) {
    sources.push({ id: 'mcp:local', kind: 'mcp', label: 'MCP (local)', enabled: true, decidedBy: null });
    for (const [n, c] of localServers) items.push(toItem('mcp:local', n, c, p.claudeJson));
  }

  const mcpJson = path.join(projectDir, '.mcp.json');
  const ap = await readApprovals(p, projectDir, proj);
  for (const [n, c] of serversOf(await readJson(mcpJson))) {
    const it = toItem('project', n, c, mcpJson);
    const dis = ap.disabled.get(n);
    const en = ap.enabled.get(n) ?? ap.enableAll;
    if (dis) {
      it.mcp!.approved = false;
      it.enabled = false;
      it.decidedBy = dis;
    } else if (en) {
      it.mcp!.approved = true;
      it.decidedBy = en;
    }
    items.push(it);
  }

  for (const pm of pluginMcp) {
    for (const [n, c] of serversOf(pm.json)) items.push(toItem(pm.sourceId, n, c, ''));
  }

  sources.push({ id: 'connectors', kind: 'connectors', label: 'claude.ai connectors', enabled: true, decidedBy: null });
  items.push({
    id: 'connectors:claude.ai',
    kind: 'mcp-server',
    name: 'claude.ai connectors (not checked)',
    fullName: 'claude.ai connectors (not checked)',
    sourceId: 'connectors',
    path: '',
    description: 'Run "Check live MCP status" to list connectors',
    enabled: true,
    decidedBy: null,
    mcp: { transport: 'unknown', endpoint: '', envKeys: [], headerKeys: [], approved: null },
  });
  return { sources, items };
}

export function parseMcpList(stdout: string): McpListEntry[] {
  const out: McpListEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cut = line.lastIndexOf(' - ');
    if (cut < 0) continue;
    const head = line.slice(0, cut);
    const tail = line.slice(cut + 3).trim();
    const m = /^(.+?): (\S.*?)(?:\s+\((?:HTTP|SSE|http|sse)\))?$/.exec(head.trim());
    if (!m) continue;
    const status: Live = /[✔✓]|Connected/.test(tail) && !/Fail/i.test(tail) ? 'connected' : /[✗✘]|Fail/i.test(tail) ? 'failed' : 'unknown';
    out.push({ name: m[1], endpoint: sanitizeEndpoint(m[2]), status });
  }
  return out;
}

export function execClaudeMcpList(projectDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('claude', ['mcp', 'list'], { cwd: projectDir, timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function liveMcpStatus(projectDir: string, run: (dir: string) => Promise<string> = execClaudeMcpList): Promise<McpListEntry[]> {
  return parseMcpList(await run(projectDir));
}
