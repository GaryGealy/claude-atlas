import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/server.js';
import { fixtureHome } from '../tests/fixtures.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: RunningServer;
let ringZero: string;
let tmp: string;

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-')));
  const home = fixtureHome();
  ringZero = home.projects.ringZero;
  server = await startServer({
    paths: { ...home.paths, cacheDir: path.join(tmp, 'cache') },
    port: 0,
    webDir: path.join(ROOT, 'dist', 'web'),
    runners: {
      mcpList: async () => '',
      claude: async () => ({ stdout: '', stderr: '', code: 1 }) as never,
      git: async () => {
        throw new Error('git must not run in e2e');
      },
      env: {},
    },
  });
});

test.afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('competes edge, hook tilt, and candidate ghost node', async ({ page }) => {
  await page.goto(`${server.url}?t=${server.token}`);
  await page.waitForFunction(() => document.querySelectorAll('#project option').length > 0);
  await page.selectOption('#project', ringZero);
  await page.waitForFunction(() => {
    const cy = (window as any).__atlasCy;
    return !!cy && cy.nodes().length > 0;
  });

  const edge = await page.evaluate(() => {
    const cy = (window as any).__atlasCy;
    const e = cy.edges('.competes').filter((x: any) => {
      const ids = [String(x.source().id()), String(x.target().id())];
      return ids.some((i) => i.endsWith(':brainstorming')) && ids.some((i) => i.endsWith(':design'));
    });
    return e.length ? { id: e[0].id() } : null;
  });
  expect(edge, 'competes edge brainstorming<->design in the default view').not.toBeNull();

  // The default view hides weaker pairs; "Show all competes" draws every one.
  const count = () => page.evaluate(() => (window as any).__atlasCy.edges('.competes').length);
  const defaultCount = await count();
  await page.getByLabel('Show all competes').check();
  await expect.poll(count).toBeGreaterThan(defaultCount);
  await page.getByLabel('Show all competes').uncheck();
  await expect.poll(count).toBe(defaultCount);

  await page.evaluate((id) => (window as any).__atlasCy.getElementById(id).emit('tap'), edge!.id);
  const panel = page.locator('#panel');
  await expect(panel).toContainText('Competes');
  await expect(panel).toContainText('injects instructions into every session');
  await expect(panel).toContainText('superpowers SessionStart hook injects skill-use instructions into every session');
  await expect(panel).toContainText('Template for a design and brainstorm step');
  await expect(panel).toContainText('brainstorming');
  await expect(panel).toContainText('You MUST use this before any creative work');

  // Candidate folder -> ghost node
  const cand = path.join(tmp, 'research');
  fs.mkdirSync(cand, { recursive: true });
  fs.writeFileSync(path.join(cand, 'SKILL.md'), '---\nname: research\ndescription: Research the codebase before planning\n---\nBody\n');
  await page.click('#candidate');
  await page.fill('input[name=path]', cand);
  await page.click('#candidate-submit');
  await expect(page.locator('#candidate-banner')).toBeVisible();
  await page.waitForFunction(() => (window as any).__atlasCy.nodes('.ghost').length > 0);
});
