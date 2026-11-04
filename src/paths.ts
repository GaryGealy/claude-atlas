import os from 'node:os';
import path from 'node:path';

export type ClaudePaths = { home: string; claudeDir: string; claudeJson: string; managedDir: string; cacheDir: string };

const MANAGED_DIR_MAC = '/Library/Application Support/ClaudeCode';

function cacheDirFor(home: string): string {
  const base = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(base, 'claude-atlas');
}

export function defaultPaths(): ClaudePaths {
  const home = os.homedir();
  return {
    home,
    claudeDir: path.join(home, '.claude'),
    claudeJson: path.join(home, '.claude.json'),
    managedDir:
      process.platform === 'darwin'
        ? MANAGED_DIR_MAC
        : process.platform === 'win32'
          ? 'C:\\Program Files\\ClaudeCode'
          : '/etc/claude-code',
    cacheDir: cacheDirFor(home),
  };
}

/** Paths rooted at an arbitrary home (used by fixtures); never touches the real machine. */
export function pathsFor(home: string): ClaudePaths {
  return {
    home,
    claudeDir: path.join(home, '.claude'),
    claudeJson: path.join(home, '.claude.json'),
    managedDir: path.join(home, 'managed'),
    cacheDir: path.join(home, '.cache', 'claude-atlas'),
  };
}
