// Thin client for the local Atlas server. The per-run token comes from the page URL (?t=) and is sent as a header.
import type { AtlasModel } from '../src/model.js';
// Type-only imports: erased at build time, so no node code reaches the bundle.
import type { ProjectEntry } from '../src/scan/projects.js';
import type { JudgeCapability } from '../src/analyze/judge.js';
import type { CandidateInput } from '../src/candidate.js';

export type { CandidateInput, JudgeCapability, ProjectEntry };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export const token: string | null = new URLSearchParams(location.search).get('t');

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-atlas-token': token ?? '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Could not reach the Atlas server. Is claude-atlas still running?', null);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

const q = (project: string): string => `project=${encodeURIComponent(project)}`;

export const api = {
  projects: () => call<ProjectEntry[]>('GET', '/api/projects'),
  model: (project: string) => call<AtlasModel>('GET', `/api/model?${q(project)}`),
  rescan: (project: string) => call<AtlasModel>('POST', `/api/rescan?${q(project)}`),
  mcpLive: (project: string) => call<AtlasModel>('POST', `/api/mcp-live?${q(project)}`),
  candidate: (project: string, input: CandidateInput) => call<AtlasModel>('POST', '/api/candidate', { project, input }),
  judgeCapability: () => call<JudgeCapability>('GET', '/api/judge/capability'),
  judge: (project: string) => call<AtlasModel>('POST', `/api/judge?${q(project)}`),
};
