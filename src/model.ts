export type SourceKind = 'user' | 'managed' | 'synced' | 'plugin' | 'project' | 'mcp' | 'connectors' | 'candidate';
export type Source = {
  id: string;
  kind: SourceKind;
  label: string;
  enabled: boolean;
  decidedBy: string | null;
  plugin?: { name: string; marketplace: string; version: string; installPath: string; scope: 'user' | 'project' | 'local' };
};

export type ItemKind = 'skill' | 'agent' | 'command' | 'hook' | 'mcp-server' | 'instruction' | 'memory';
export type Item = {
  id: string;
  kind: ItemKind;
  name: string;
  fullName: string;
  sourceId: string;
  path: string;
  description: string;
  enabled: boolean;
  decidedBy: string | null;
  conditional?: boolean;
  ghost?: boolean;
  tracedFrom?: { plugin: string; version: string; similarity: number; edited: boolean };
  hook?: { event: string; matcher: string | null; command: string; text: string /* command + resolved script, ≤4 KB */; mentionsSkills: boolean };
  mcp?: {
    transport: 'stdio' | 'http' | 'sse' | 'unknown';
    endpoint: string;
    envKeys: string[];
    headerKeys: string[];
    approved: boolean | null;
    live?: 'connected' | 'failed' | 'unknown';
  };
  fired?: { claude: number; typed: number };
};

export type CompeteReason = 'name-collision' | `phase:${string}` | 'similar-description';
export type Tilt = { itemId: string; kind: 'hook-injects' | 'imperative-wording' | 'disabled'; detail: string };
export type Edge = {
  id: string;
  kind: 'provides' | 'competes' | 'injects';
  from: string;
  to: string;
  competes?: {
    reasons: CompeteReason[];
    /** Description cosine similarity. */
    score: number;
    /** How strongly the pair competes (reasons, phase evidence in names, tilt); drives the default view and the judge. */
    strength: number;
    tilt: Tilt[];
    judge?: { same: boolean; why: string };
  };
};
export type AtlasModel = {
  project: string;
  scannedAt: string;
  sources: Source[];
  items: Item[];
  edges: Edge[];
  warnings: string[];
};
export const EVERY_SESSION_ID = 'node:every-session';
