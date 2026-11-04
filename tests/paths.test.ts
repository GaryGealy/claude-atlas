import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { defaultPaths, pathsFor } from '../src/paths.js';
import { fixtureHome } from './fixtures.js';

describe('paths', () => {
  it('pathsFor roots everything under the given home', () => {
    const p = pathsFor('/h');
    expect(p.claudeDir).toBe('/h/.claude');
    expect(p.claudeJson).toBe('/h/.claude.json');
    expect(p.managedDir).toBe('/h/managed');
  });

  it('defaultPaths cache dir ends with claude-atlas', () => {
    expect(defaultPaths().cacheDir.endsWith('claude-atlas')).toBe(true);
  });
});

describe('fixtureHome', () => {
  it('returns existing directories, except gone', () => {
    const { paths, projects } = fixtureHome();
    expect(fs.statSync(paths.claudeDir).isDirectory()).toBe(true);
    expect(fs.statSync(projects.ringZero).isDirectory()).toBe(true);
    expect(fs.statSync(projects.plain).isDirectory()).toBe(true);
    expect(fs.existsSync(projects.gone)).toBe(false);
  });

  it('rewrites placeholders and sets transcript mtimes', () => {
    const { paths, projects } = fixtureHome();
    const json = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
    expect(Object.keys(json.projects)).toContain(projects.ringZero);
    expect(fs.readFileSync(paths.claudeJson, 'utf8')).not.toContain('__HOME__');
    const installed = JSON.parse(fs.readFileSync(path.join(paths.claudeDir, 'plugins/installed_plugins.json'), 'utf8'));
    expect(installed.plugins['localtool@local'][0].projectPath).toBe(projects.ringZero);
    const enc = projects.ringZero.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(paths.claudeDir, 'projects', enc);
    const recent = fs.statSync(path.join(dir, 'recent-session.jsonl')).mtimeMs;
    const old = fs.statSync(path.join(dir, 'old-session.jsonl')).mtimeMs;
    expect(Date.now() - recent).toBeLessThan(5 * 60_000);
    expect(Math.round((Date.now() - old) / 86_400_000)).toBe(40);
    expect(fs.readFileSync(path.join(dir, 'recent-session.jsonl'), 'utf8')).toContain(`"cwd":"${projects.ringZero}"`);
  });
});
