import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ClaudePaths } from './paths.js';
import type { AtlasModel, Item } from './model.js';
import { buildModel } from './build.js';
import { listProjects } from './scan/projects.js';
import { execClaudeMcpList, liveMcpStatus } from './scan/mcp.js';
import { judgePairs, probeJudge, runClaude, type JudgeCapability, type JudgeRun } from './analyze/judge.js';
import { loadCandidate, runGit, type CandidateInput, type GitRunner } from './candidate.js';

export type ServerOpts = {
  paths: ClaudePaths;
  port: number;
  webDir: string;
  runners?: { mcpList?: (dir: string) => Promise<string>; claude?: JudgeRun; git?: GitRunner; env?: NodeJS.ProcessEnv };
};
export type RunningServer = { url: string; token: string; address: AddressInfo; close(): Promise<void> };

const MAX_BODY = 1024 * 1024;
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseCandidateInput(v: unknown): CandidateInput {
  const o = v as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    if (o.kind === 'path' && isStr(o.path)) return { kind: 'path', path: o.path };
    if (o.kind === 'git' && isStr(o.url)) return { kind: 'git', url: o.url };
    if (o.kind === 'marketplace' && isStr(o.marketplace) && isStr(o.plugin)) return { kind: 'marketplace', marketplace: o.marketplace, plugin: o.plugin };
  }
  throw new HttpError(400, 'Invalid candidate input');
}

async function requireDir(project: string | null): Promise<string> {
  if (!project) throw new HttpError(400, 'Missing project parameter');
  const abs = path.resolve(project);
  let ok = false;
  try {
    ok = (await fs.stat(abs)).isDirectory();
  } catch {
    /* not found */
  }
  if (!ok) throw new HttpError(404, `Project directory not found: ${abs}`);
  return abs;
}

function applyLive(model: AtlasModel, entries: Awaited<ReturnType<typeof liveMcpStatus>>): AtlasModel {
  const m: AtlasModel = structuredClone(model);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const placeholder = m.items.find((i) => i.id === 'connectors:claude.ai');
  m.items = m.items.filter((i) => i.id !== 'connectors:claude.ai');
  m.edges = m.edges.filter((e) => !(e.kind === 'provides' && e.to === 'connectors:claude.ai'));
  for (const it of m.items) {
    if (it.kind !== 'mcp-server' || !it.mcp) continue;
    it.mcp.live = byName.get(it.name)?.status ?? 'unknown';
  }
  const known = new Set(m.items.map((i) => i.id));
  for (const e of entries) {
    if (!e.name.startsWith('claude.ai ')) continue;
    const id = `connectors:${e.name}`;
    if (known.has(id)) continue;
    const item: Item = {
      id,
      kind: 'mcp-server',
      name: e.name,
      fullName: e.name,
      sourceId: 'connectors',
      path: '',
      description: e.endpoint,
      enabled: true,
      decidedBy: null,
      mcp: { transport: 'unknown', endpoint: e.endpoint, envKeys: [], headerKeys: [], approved: null, live: e.status },
    };
    m.items.push(item);
    if (placeholder || m.sources.some((s) => s.id === 'connectors')) {
      m.edges.push({ id: `provides:connectors|${id}`, kind: 'provides', from: 'connectors', to: id });
    }
  }
  return m;
}

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const { paths, webDir } = opts;
  const mcpList = opts.runners?.mcpList ?? execClaudeMcpList;
  const claude = opts.runners?.claude ?? runClaude;
  const git = opts.runners?.git ?? runGit;
  const env = opts.runners?.env ?? process.env;
  const token = crypto.randomBytes(32).toString('hex');
  const cache = new Map<string, AtlasModel>();
  let capability: Promise<JudgeCapability> | null = null;
  let port = 0;
  const webRoot = path.resolve(webDir);

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(text);
  };

  const cached = async (dir: string): Promise<AtlasModel> => {
    let m = cache.get(dir);
    if (!m) {
      m = await buildModel(paths, dir);
      cache.set(dir, m);
    }
    return m;
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = url.pathname;
    const method = req.method ?? 'GET';
    const need = (m: 'GET' | 'POST'): void => {
      if (method !== m) throw new HttpError(405, 'Method not allowed');
    };
    const project = url.searchParams.get('project');

    switch (route) {
      case '/api/projects':
        need('GET');
        return send(res, 200, await listProjects(paths));
      case '/api/model': {
        need('GET');
        return send(res, 200, await cached(await requireDir(project)));
      }
      case '/api/rescan': {
        need('POST');
        const dir = await requireDir(project);
        const m = await buildModel(paths, dir);
        cache.set(dir, m);
        return send(res, 200, m);
      }
      case '/api/mcp-live': {
        need('POST');
        const dir = await requireDir(project);
        const base = await cached(dir);
        const m = applyLive(base, await liveMcpStatus(dir, mcpList));
        cache.set(dir, m);
        return send(res, 200, m);
      }
      case '/api/candidate': {
        need('POST');
        const body = (await readBody(req)) as { project?: unknown; input?: unknown } | null;
        const input = parseCandidateInput(body?.input);
        if (!body || !isStr(body.project)) throw new HttpError(400, 'Missing project');
        const dir = await requireDir(body.project);
        const candidate = await loadCandidate(input, paths, git);
        return send(res, 200, await buildModel(paths, dir, { candidate }));
      }
      case '/api/judge/capability':
        need('GET');
        capability ??= probeJudge(claude, env);
        return send(res, 200, await capability);
      case '/api/judge': {
        need('POST');
        const dir = await requireDir(project);
        capability ??= probeJudge(claude, env);
        const cap = await capability;
        if (!cap.available) throw new HttpError(409, 'Judge unavailable', cap);
        const m = await cached(dir);
        await judgePairs(m.edges, m.items, paths, cap, claude);
        return send(res, 200, m);
      }
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (rel.includes('\0')) throw new HttpError(404, 'Not found');
    const file = path.resolve(webRoot, '.' + (rel === '/' ? '/index.html' : rel));
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) throw new HttpError(404, 'Not found');
    let data: Buffer;
    try {
      data = await fs.readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? '';
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Forbidden host');
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          const header = req.headers['x-atlas-token'];
          const given = url.searchParams.get('t') ?? (Array.isArray(header) ? header[0] : header);
          if (!tokenOk(given, token)) throw new HttpError(401, 'Missing or invalid token');
          await api(req, res, url);
        } else {
          await serveStatic(req, res, url);
        }
      } catch (err) {
        if (res.headersSent) return res.end();
        if (err instanceof HttpError) send(res, err.status, err.body ?? { error: err.message });
        else send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
