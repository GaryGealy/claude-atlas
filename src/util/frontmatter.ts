import { parse } from 'yaml';

export type Frontmatter = { data: Record<string, unknown>; body: string; error: string | null };

const FM = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Frontmatter {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text, error: null };
  const body = text.slice(m[0].length);
  try {
    const v = parse(m[1]);
    if (v === null || v === undefined) return { data: {}, body, error: null };
    if (typeof v !== 'object' || Array.isArray(v)) return { data: {}, body, error: 'frontmatter is not a mapping' };
    return { data: v as Record<string, unknown>, body, error: null };
  } catch (e) {
    return { data: {}, body, error: (e as Error).message.split('\n')[0] };
  }
}
