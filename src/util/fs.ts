import fs from 'node:fs/promises';
import path from 'node:path';

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export type WalkOpts = { warn?: (m: string) => void; maxDepth?: number };

/**
 * Yields `dir` and every directory beneath it, following symlinks. Real paths of the
 * current ancestor chain are tracked; a symlink resolving to an ancestor is reported
 * once via `opts.warn` and not descended into. Missing or unreadable dirs yield nothing.
 */
export async function* walkDirs(dir: string, opts: WalkOpts = {}): AsyncGenerator<string> {
  let root: string;
  try {
    root = await fs.realpath(dir);
  } catch {
    return;
  }
  const reported = new Set<string>();
  async function* rec(p: string, real: string, ancestors: Set<string>, depth: number): AsyncGenerator<string> {
    yield p;
    if (opts.maxDepth !== undefined && depth >= opts.maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const chain = new Set(ancestors).add(real);
    for (const e of entries) {
      const child = path.join(p, e.name);
      let childReal: string;
      try {
        if (!(await fs.stat(child)).isDirectory()) continue;
        childReal = await fs.realpath(child);
      } catch {
        continue; // broken symlink or unreadable
      }
      if (chain.has(childReal)) {
        if (!reported.has(child)) {
          reported.add(child);
          opts.warn?.(`Symlink loop skipped: ${child} -> ${childReal}`);
        }
        continue;
      }
      yield* rec(child, childReal, chain, depth + 1);
    }
  }
  yield* rec(dir, root, new Set(), 0);
}

/** Reads at most `max` bytes from the start of a regular file; null when unreadable or not a regular file. */
export async function readHead(file: string, max = 4096): Promise<Buffer | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, 'r');
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
