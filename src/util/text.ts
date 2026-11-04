const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with',
]);

/** Lowercase words (split on non-alphanumerics) with stopwords removed. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

export type TermFreq = { f: Map<string, number>; norm: number };

/** Precomputed term-frequency map and its norm, for repeated cosine comparisons. */
export function termFreq(s: string): TermFreq {
  const f = new Map<string, number>();
  for (const w of tokens(s)) f.set(w, (f.get(w) ?? 0) + 1);
  return { f, norm: Math.sqrt([...f.values()].reduce((t, n) => t + n * n, 0)) };
}

export function cosineTf(a: TermFreq, b: TermFreq): number {
  let dot = 0;
  for (const [w, n] of a.f) dot += n * (b.f.get(w) ?? 0);
  const d = a.norm * b.norm;
  return d === 0 ? 0 : Math.min(1, dot / d);
}

/** Term-frequency cosine similarity in [0, 1]; 0 when either side has no tokens. */
export function cosine(a: string, b: string): number {
  return cosineTf(termFreq(a), termFreq(b));
}
