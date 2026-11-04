import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPaths } from './paths.js';
import { startServer } from './server.js';

function parseArgs(argv: string[]): { port: number; open: boolean } {
  let port = 0;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-open') open = false;
    else if (argv[i] === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port needs an integer between 0 and 65535');
      port = n;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { port, open };
}

async function main(): Promise<void> {
  let args: { port: number; open: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\nUsage: claude-atlas [--port <n>] [--no-open]`);
    process.exit(2);
  }
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  const srv = await startServer({ paths: defaultPaths(), port: args.port, webDir });
  const full = `${srv.url}?t=${srv.token}`;
  console.log(`Claude Atlas: ${full}`);
  if (args.open) {
    try {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [full], { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      /* ignore: the URL is printed */
    }
  }
  process.on('SIGINT', () => {
    void srv.close().then(() => process.exit(0));
  });
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
