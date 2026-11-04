import { describe, expect, it } from 'vitest';
import { redactArgs, redactText, sanitizeUrl } from '../../src/util/redact.js';

describe('redactText', () => {
  it('masks header values after -H / --header, quoted or not, keeping header names', () => {
    expect(redactText('curl -H "X-API-Key: abc123" https://h/x')).toBe('curl -H "X-API-Key: ***" https://h/x');
    expect(redactText("curl --header 'Authorization: Bearer tok'")).toBe("curl --header 'Authorization: ***'");
    expect(redactText('curl -H X-Token:abc https://h')).toBe('curl -H X-Token:*** https://h/');
    expect(redactText('curl -H "X-Plain: visible-but-header" x')).toBe('curl -H "X-Plain: ***" x');
  });

  it('masks --header=Name=value and --header=Name: value', () => {
    expect(redactText('srv --header=X-Key=abc --port 1')).toBe('srv --header=X-Key=*** --port 1');
    expect(redactText('srv --header="X-Key: abc def" --port 1')).toBe('srv --header="X-Key: ***" --port 1');
    expect(redactText("srv --header='X-Key=abc'")).toBe("srv --header='X-Key=***'");
  });

  it('masks long mixed letter+digit URL path segments, keeps ordinary ones', () => {
    expect(redactText('npx mcp-remote https://hooks.example.com/services/T0ABCDEF12/abcDEF1234567890xyzQ/mcp')).toBe(
      'npx mcp-remote https://hooks.example.com/services/T0ABCDEF12/***/mcp',
    );
    expect(sanitizeUrl('https://h.io/mcp/v1/some-long-but-lettersonly-name')).toBe('https://h.io/mcp/v1/some-long-but-lettersonly-name');
    expect(sanitizeUrl('https://h.io/12345678901234567890123')).toBe('https://h.io/12345678901234567890123');
    expect(sanitizeUrl('https://u:p@h.io/a1b2c3d4e5f6g7h8i9j0k1?x=1')).toBe('https://h.io/***');
  });

  it('masks secret flags, NAME=value, Bearer and JSON-ish secrets in scripts, leaving ordinary text alone', () => {
    const script = [
      '#!/bin/sh',
      'export GITHUB_TOKEN="ghp_abc"',
      'API_KEY=xyz node run.js --api-key k1 --token=k2 --port 80',
      'curl -H "Authorization: Bearer zzz" https://api.example.com/v1?key=q',
      'echo \'{"client_secret": "s3"}\'',
      'skill_md="${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md"',
    ].join('\n');
    const out = redactText(script);
    for (const s of ['ghp_abc', 'xyz', 'k1', 'k2', 'zzz', 'key=q', 's3']) expect(out).not.toContain(s);
    expect(out).toContain('GITHUB_TOKEN=***');
    expect(out).toContain('--port 80');
    expect(out).toContain('skill_md="${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md"');
  });
});

describe('redactArgs', () => {
  it('masks header args (separate, joined and standalone) and secret flags', () => {
    expect(redactArgs(['-H', 'X-API-Key: abc', '--header', 'Authorization: Bearer t', '--header=X-Key=v', 'X-API-Key: abc', '--port', '80'])).toEqual([
      '-H', 'X-API-Key: ***', '--header', 'Authorization: Bearer ***', '--header=X-Key=***', 'X-API-Key: ***', '--port', '80',
    ]);
  });
});
