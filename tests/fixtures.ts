import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsFor, type ClaudePaths } from '../src/paths.js';

const FIXTURE_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'home');
const HOME_TOKEN = '__HOME__';
const ENC_TOKEN = '__ENC_RING_ZERO__';
const DAY_MS = 86_400_000;
const created: string[] = [];

process.on('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

export function encodeProjectDir(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function rewriteTokens(dir: string, home: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rewriteTokens(full, home);
    else if (/\.(json|jsonl)$/.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(HOME_TOKEN)) fs.writeFileSync(full, text.split(HOME_TOKEN).join(home));
    }
  }
}

/** Copies tests/fixtures/home to a fresh temp dir and returns paths inside it. */
export function fixtureHome(): { paths: ClaudePaths; projects: { ringZero: string; plain: string; gone: string } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fixture-'));
  created.push(root);
  const home = fs.realpathSync(root);
  fs.cpSync(FIXTURE_HOME, home, { recursive: true });
  rewriteTokens(home, home);

  const projects = {
    ringZero: path.join(home, 'repos', 'ring-zero'),
    plain: path.join(home, 'repos', 'plain'),
    gone: path.join(home, 'repos', 'gone'),
  };

  const projectsDir = path.join(home, '.claude', 'projects');
  const transcriptDir = path.join(projectsDir, encodeProjectDir(projects.ringZero));
  fs.renameSync(path.join(projectsDir, ENC_TOKEN), transcriptDir);

  // Copies and git do not preserve mtime: set it explicitly so the "last 30 days" window is deterministic.
  const now = new Date();
  fs.utimesSync(path.join(transcriptDir, 'recent-session.jsonl'), now, now);
  const old = new Date(now.getTime() - 40 * DAY_MS);
  fs.utimesSync(path.join(transcriptDir, 'old-session.jsonl'), old, old);

  return { paths: pathsFor(home), projects };
}
