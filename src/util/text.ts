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

function freq(ws: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** Term-frequency cosine similarity in [0, 1]; 0 when either side has no tokens. */
export function cosine(a: string, b: string): number {
  const fa = freq(tokens(a));
  const fb = freq(tokens(b));
  let dot = 0;
  for (const [w, n] of fa) dot += n * (fb.get(w) ?? 0);
  const norm = (f: Map<string, number>) => Math.sqrt([...f.values()].reduce((s, n) => s + n * n, 0));
  const d = norm(fa) * norm(fb);
  return d === 0 ? 0 : Math.min(1, dot / d);
}
