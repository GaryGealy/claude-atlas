import { EVERY_SESSION_ID, type CompeteReason, type Edge, type Item } from '../model.js';
import { cosineTf, termFreq } from '../util/text.js';

const PHASES: [string, string[]][] = [
  ['design', ['design', 'brainstorm', 'ideate', 'creative']],
  ['plan', ['plan', 'planning']],
  ['implement', ['implement', 'execute', 'build']],
  ['research', ['research', 'investigate', 'document codebase']],
  ['review', ['review', 'audit']],
  ['ship', ['commit', 'pull request', 'PR', 'release']],
];

export const EVERY_SESSION_EVENTS = ['SessionStart', 'UserPromptSubmit'];

function words(text: string): string[] {
  return text.toLowerCase().split(/[\s\p{P}\p{S}_:-]+/u).filter(Boolean);
}

function termMatches(ws: string[], term: string): boolean {
  const t = words(term);
  for (let i = 0; i + t.length <= ws.length; i++) {
    let ok = true;
    for (let j = 0; j < t.length && ok; j++) {
      const w = ws[i + j];
      ok = j === t.length - 1 ? w === t[j] || w === t[j] + 's' : w === t[j];
    }
    if (ok) return true;
  }
  return false;
}

export function phasesOf(text: string): string[] {
  const ws = words(text);
  return PHASES.filter(([, terms]) => terms.some((t) => termMatches(ws, t))).map(([p]) => p);
}

const PAIR_KINDS = new Set(['skill', 'agent', 'command']);

export function findCompetes(items: Item[], threshold = 0.35): Edge[] {
  const cands = items
    .filter((i) => PAIR_KINDS.has(i.kind))
    .map((item) => {
      const text = `${item.name} ${item.description}`;
      return { item, tf: termFreq(text), phases: phasesOf(text) };
    });
  const edges: Edge[] = [];
  for (let x = 0; x < cands.length; x++) {
    for (let y = x + 1; y < cands.length; y++) {
      const [a, b] = [cands[x], cands[y]].sort((p, q) => (p.item.id < q.item.id ? -1 : 1));
      if (a.item.sourceId === b.item.sourceId) continue;
      const reasons: CompeteReason[] = [];
      if (a.item.name === b.item.name) reasons.push('name-collision');
      for (const p of a.phases) if (b.phases.includes(p)) reasons.push(`phase:${p}`);
      const sim = cosineTf(a.tf, b.tf);
      if (sim >= threshold) reasons.push('similar-description');
      if (!reasons.length) continue;
      edges.push({
        id: `competes:${a.item.id}|${b.item.id}`,
        kind: 'competes',
        from: a.item.id,
        to: b.item.id,
        competes: { reasons, score: Math.round(sim * 100) / 100, tilt: [] },
      });
    }
  }
  return edges;
}

export function injectEdges(items: Item[]): Edge[] {
  return items
    .filter((i) => i.kind === 'hook' && i.hook && EVERY_SESSION_EVENTS.includes(i.hook.event))
    .map((h) => ({ id: `injects:${h.id}`, kind: 'injects' as const, from: h.id, to: EVERY_SESSION_ID }));
}
