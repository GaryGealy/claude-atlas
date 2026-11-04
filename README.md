# Claude Atlas

A read-only local map of your Claude Code environment. Atlas scans your skills, commands, agents, hooks, MCP servers and plugins, draws them as a graph, and shows where items compete for the same request and which hooks inject instructions into every session. It never edits your Claude configuration.

## Install

Download the release tarball, then:

```sh
npm i -g ./claude-atlas-x.y.z.tgz
claude-atlas            # opens your browser
claude-atlas --port 4321 --no-open
```

Requires Node 22+. The server binds to `127.0.0.1` only and every run uses a fresh random token (the page URL carries it as `?t=`). Secrets found in config (env values, headers, tokens) are masked.

## What each button touches

- **Rescan**: re-reads files on disk. Nothing else.
- **Check live MCP status**: runs `claude mcp list` from the project. This starts stdio MCP servers and contacts remote ones.
- **Try a skill before installing...**: loads a local folder or `SKILL.md` with no side effects; a zip is extracted into the cache. A git URL or marketplace plugin is shallow-cloned (`git clone`) into the cache. Nothing is installed; the result is shown as ghost nodes.
- **Ask Claude to judge**: runs an isolated `claude -p --bare ...` (no hooks, plugins or MCP) asking whether competing pairs would be chosen for the same request. `--bare` does not read OAuth credentials, so this needs `ANTHROPIC_API_KEY` (or Bedrock/Vertex/Foundry environment variables). Without them the button is disabled and says why.

## Cache

Cloned candidates and other cache data live in `$XDG_CACHE_HOME/claude-atlas`, default `~/.cache/claude-atlas`. Delete it any time.

## Development

```sh
npm ci
npm test            # unit tests
npm run build
npm run e2e         # Playwright; needs `npm run build` first and `npx playwright install chromium`
```
