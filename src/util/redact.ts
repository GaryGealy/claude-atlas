// Shared secret redaction for anything shown from commands, args or scripts (MCP endpoints, hook commands and text).
// Names are kept; values that look secret become ***.

export const SECRET_NAME = /key|token|secret|password|passwd|auth|bearer|credential/i;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const MASK = '***';

/** A URL path segment that looks like an embedded credential: ≥ 20 chars of [A-Za-z0-9_-] mixing letters and digits. */
function secretSegment(seg: string): boolean {
  return seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg);
}

const maskPath = (p: string): string => p.split('/').map((s) => (secretSegment(s) ? MASK : s)).join('/');

/** Drops userinfo, query and fragment, and masks credential-like path segments. */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    u.pathname = maskPath(u.pathname);
    return u.toString();
  } catch {
    const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@\s]*@)?([^/?#\s]*)([^?#\s]*)/i.exec(raw);
    return m ? `${m[1]}${m[2]}${maskPath(m[3] ?? '')}` : raw;
  }
}

/** Strips query, fragment and userinfo from every URL in the string, and redacts Bearer/Basic values. */
export function sanitizeEndpoint(urlOrCommand: string): string {
  return urlOrCommand.replace(URL_RE, sanitizeUrl).replace(/\b(Bearer|Basic)\s+(?!\*\*\*)[^\s"']+/gi, `$1 ${MASK}`);
}

/** `Name: value` / `Name=value` header text with the value masked (a Bearer/Basic scheme word is kept). */
function maskHeader(h: string): string {
  const m = /^([A-Za-z0-9_-]+)(\s*[:=]\s*)(.*)$/s.exec(h);
  if (!m || !m[3]) return h;
  const scheme = /^(Bearer|Basic)\s+/i.exec(m[3]);
  return `${m[1]}${m[2]}${scheme ? `${scheme[1]} ` : ''}${MASK}`;
}

/**
 * Redacts secrets in free text (a shell command or a script): URLs, Bearer/Basic, header values after -H/--header,
 * secret-named flags and NAME=value assignments, `Secret-Name: value` and `"secret_name": "value"`.
 */
export function redactText(text: string): string {
  let s = sanitizeEndpoint(text);
  // -H "Name: value" / -H 'Name: value' / --header "Name: value"
  s = s.replace(/(^|\s)(-H|--header)(\s+)(["'])([A-Za-z0-9_-]+)(\s*:\s*)[^"'\n]*\4/g, (_m, pre, f, sp, q, n, sep) => `${pre}${f}${sp}${q}${n}${sep}${MASK}${q}`);
  // -H Name:value (unquoted) and -H Name: value
  s = s.replace(/(^|\s)(-H|--header)(\s+)([A-Za-z0-9_-]+):(\s*)(?!\*\*\*)([^\s"']+)/g, (_m, pre, f, sp, n, sp2) => `${pre}${f}${sp}${n}:${sp2}${MASK}`);
  // --header="Name: value" / --header='Name=value'
  s = s.replace(/(--header=)(["'])([A-Za-z0-9_-]+)(\s*[:=]\s*)[^"'\n]*\2/g, (_m, f, q, n, sep) => `${f}${q}${n}${sep}${MASK}${q}`);
  // --header=Name=value / --header=Name: value (unquoted)
  s = s.replace(/(--header=)([A-Za-z0-9_-]+)(=|:\s*)(?!\*\*\*)([^\s"']+)/g, (_m, f, n, sep) => `${f}${n}${sep}${MASK}`);
  // --api-key VALUE / --token=VALUE
  s = s.replace(/(^|[\s"'])(-{1,2}[A-Za-z0-9_.-]+)(=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/g, (m, pre, flag, sep, val) =>
    SECRET_NAME.test(flag) && val !== MASK ? `${pre}${flag}${sep}${MASK}` : m,
  );
  // NAME=value, export NAME="value"
  s = s.replace(/(^|[\s;"'(])([A-Za-z_][A-Za-z0-9_.-]*)=("[^"\n]*"|'[^'\n]*'|[^\s;"')]*)/g, (m, pre, name, val) =>
    SECRET_NAME.test(name) && val && val !== MASK ? `${pre}${name}=${MASK}` : m,
  );
  // Secret-Name: value (header-style); a Bearer/Basic scheme word is kept
  s = s.replace(/(^|[\s"'])([A-Za-z0-9_-]+):([ \t]*)(?!\*\*\*|Bearer\b|Basic\b)([^\s"']+)/g, (m, pre, name, sp) =>
    SECRET_NAME.test(name) ? `${pre}${name}:${sp}${MASK}` : m,
  );
  // "secret_name": "value" (JSON-ish)
  s = s.replace(/(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)(["'])[^"'\n]*\4/g, (m, q, name, sep, q2) => (SECRET_NAME.test(name) ? `${q}${name}${q}${sep}${q2}${MASK}${q2}` : m));
  return s;
}

/** Redacts secret-looking values in an argv array: secret flag values, NAME=value, header values, Bearer/Basic. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let next: 'value' | 'header' | null = null;
  for (const a of args) {
    if (next === 'header') {
      next = null;
      out.push(maskHeader(a));
      continue;
    }
    if (next === 'value' && !a.startsWith('-')) {
      next = null;
      out.push(MASK);
      continue;
    }
    next = null;
    if (a === '-H' || a === '--header') {
      out.push(a);
      next = 'header';
      continue;
    }
    if (a.startsWith('--header=')) {
      out.push(`--header=${maskHeader(a.slice('--header='.length))}`);
      continue;
    }
    const m = /^(-{1,2}[^=\s]+)(=)(.*)$/.exec(a) ?? /^([A-Za-z_][\w.-]*)(=)(.*)$/.exec(a);
    if (m && SECRET_NAME.test(m[1]!)) out.push(`${m[1]}=${MASK}`);
    else if (/^-{1,2}[^=\s]+$/.test(a) && SECRET_NAME.test(a)) {
      out.push(a);
      next = 'value';
    } else if (/^[A-Za-z0-9_-]+:\s*\S/.test(a) && SECRET_NAME.test(a.slice(0, a.indexOf(':')))) out.push(maskHeader(a));
    else out.push(a);
  }
  return out;
}
