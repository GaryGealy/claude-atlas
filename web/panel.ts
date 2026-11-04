// Side panel. Model text (names, descriptions, hook text, paths) is untrusted: it is only ever set via text nodes.
import { defaultCompetes } from '../src/analyze/strength.js';
import { EVERY_SESSION_ID, type AtlasModel, type CompeteReason, type Edge, type Item, type Source, type Tilt } from '../src/model.js';

type Child = Node | string | number | null | undefined | false;

/** Builds an element. String children become text nodes; attributes are set with setAttribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const EVERY_SESSION_EVENTS = ['SessionStart', 'UserPromptSubmit'];
export const CANDIDATE_HOOK_CALLOUT = 'This would inject instructions into every session.';

/** Plain words for one tilt. For hook-injects / imperative-wording the item is favoured; for disabled it is the one turned off. */
export function tiltText(t: Tilt, lookup: (id: string) => Item | undefined): string {
  const it = lookup(t.itemId);
  const name = it?.name ?? t.itemId;
  switch (t.kind) {
    case 'hook-injects':
      return `Favours ${name}: a hook injects instructions into every session, before Claude picks a skill (${t.detail}).`;
    case 'imperative-wording':
      return `Favours ${name}: its description uses imperative wording ("MUST", "Use when"), while the other only says what it does, so Claude tends to pick ${name} first.`;
    case 'disabled':
      return `${it?.fullName ?? name} is turned off, so it will not fire; the other one wins by default.`;
  }
}

export function reasonText(r: CompeteReason, score: number): string {
  if (r === 'name-collision') return 'Same short name in different sources';
  if (r === 'similar-description') return `Descriptions are ${Math.round(score * 100)}% similar`;
  return `Both cover the ${r.slice('phase:'.length)} phase`;
}

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;
export type PanelCtx = { model: AtlasModel; select: (sel: Selection) => void };

const KIND_NAMES: Record<Item['kind'], string> = {
  skill: 'Skill',
  agent: 'Agent',
  command: 'Command',
  hook: 'Hook',
  'mcp-server': 'MCP server',
  instruction: 'Instruction file',
  memory: 'Memory',
};

function row(label: string, ...value: Child[]): HTMLElement[] {
  return [h('dt', null, label), h('dd', null, ...value)];
}
const code = (s: string): HTMLElement => h('code', null, s);
const pre = (s: string): HTMLElement => h('pre', null, s);

function sourceDetail(s: Source | undefined): Child[] {
  if (!s) return ['unknown source'];
  const out: Child[] = [s.label];
  if (s.plugin) out.push(h('div', { class: 'muted' }, `plugin ${s.plugin.name} ${s.plugin.version} · marketplace ${s.plugin.marketplace} · ${s.plugin.scope} scope`));
  return out;
}

function enabledText(enabled: boolean, decidedBy: string | null): string {
  return `${enabled ? 'On' : 'Off'}${decidedBy ? ` (decided by ${decidedBy})` : ''}`;
}

function firedText(it: Item): string | null {
  if (!it.fired) return null;
  return `Claude chose it ${it.fired.claude}× · you typed it ${it.fired.typed}× (last 30 days)`;
}

function itemLink(it: Item | undefined, id: string, ctx: PanelCtx): HTMLElement {
  const b = h('button', { type: 'button', class: 'link' }, it?.name ?? id);
  b.addEventListener('click', () => ctx.select({ type: 'node', id }));
  return b;
}

function renderItem(it: Item, ctx: PanelCtx): HTMLElement[] {
  const m = ctx.model;
  const src = m.sources.find((s) => s.id === it.sourceId);
  const out: HTMLElement[] = [
    h('h2', null, it.name),
    h('div', { class: 'muted' }, it.fullName),
    h('div', { class: 'badges' }, h('span', { class: 'badge' }, KIND_NAMES[it.kind]), it.ghost ? h('span', { class: 'badge ghost' }, 'Candidate — not installed') : null, !it.enabled ? h('span', { class: 'badge off' }, 'Off') : null),
  ];
  if (it.kind === 'hook' && it.ghost) out.push(h('div', { class: 'callout' }, CANDIDATE_HOOK_CALLOUT));
  else if (it.kind === 'hook' && it.hook && EVERY_SESSION_EVENTS.includes(it.hook.event))
    out.push(h('div', { class: 'callout' }, `This ${it.hook.event} hook injects instructions into every session.`));

  const dl = h('dl');
  dl.append(...row('Description', it.description ? h('p', { class: 'desc' }, it.description) : h('span', { class: 'muted' }, '(none)')));
  if (it.path) dl.append(...row('Path', code(it.path)));
  dl.append(...row(src?.kind === 'plugin' ? 'Source' : 'Scope / source', ...sourceDetail(src)));
  dl.append(...row('Enabled', enabledText(it.enabled, it.decidedBy)));
  if (it.conditional) dl.append(...row('Loads', 'Only when Claude works in that folder (conditional)'));
  if (it.tracedFrom) {
    const t = it.tracedFrom;
    dl.append(...row('Made by', `made by ${t.plugin} setup, ${Math.round(t.similarity * 100)}% match${t.edited ? ', edited' : ''} (template version ${t.version})`));
  }
  const fired = firedText(it);
  if (fired) dl.append(...row('Fired', fired));
  if (it.hook) {
    dl.append(...row('Event', it.hook.event + (it.hook.matcher ? ` (matcher ${it.hook.matcher})` : '')));
    dl.append(...row('Command', code(it.hook.command)));
    if (it.hook.text && it.hook.text !== it.hook.command) dl.append(...row('Hook text', h('details', null, h('summary', null, 'Show command and resolved script'), pre(it.hook.text))));
  }
  if (it.mcp) {
    const x = it.mcp;
    dl.append(...row('Transport', x.transport));
    if (x.endpoint) dl.append(...row('Endpoint', code(x.endpoint)));
    dl.append(...row('Env keys', x.envKeys.length ? x.envKeys.join(', ') : '(none)'));
    if (x.headerKeys.length) dl.append(...row('Header keys', x.headerKeys.join(', ')));
    dl.append(...row('Approved', x.approved === null ? 'n/a' : x.approved ? 'yes' : 'not approved'));
    dl.append(...row('Live status', x.live ?? 'not checked'));
  }
  out.push(dl);

  // Every competing pair, strongest first, including ones the map hides by default.
  const comps = m.edges
    .filter((e) => e.kind === 'competes' && (e.from === it.id || e.to === it.id))
    .sort((a, b) => (b.competes?.strength ?? 0) - (a.competes?.strength ?? 0));
  if (comps.length) {
    const byId = new Map(m.items.map((i) => [i.id, i]));
    const shown = defaultCompetes(m.edges, m.items);
    const ul = h('ul', { class: 'comp-list' });
    for (const e of comps) {
      const other = e.from === it.id ? e.to : e.from;
      const open = h('button', { type: 'button', class: 'link' }, 'why?');
      open.addEventListener('click', () => ctx.select({ type: 'edge', id: e.id }));
      const note = `strength ${e.competes?.strength ?? 0}${shown.has(e.id) ? '' : ' · hidden by default'}`;
      ul.append(h('li', null, itemLink(byId.get(other), other, ctx), ' ', h('span', { class: 'muted' }, note), ' ', open));
    }
    out.push(h('h3', null, `Competes with (${comps.length})`), ul);
  }
  return out;
}

function renderSource(s: Source, ctx: PanelCtx): HTMLElement[] {
  const items = ctx.model.items.filter((i) => i.sourceId === s.id);
  const dl = h('dl');
  dl.append(...row('Kind', s.kind));
  dl.append(...row('Enabled', enabledText(s.enabled, s.decidedBy)));
  if (s.plugin) {
    dl.append(...row('Plugin', `${s.plugin.name} ${s.plugin.version}`));
    dl.append(...row('Marketplace', s.plugin.marketplace));
    dl.append(...row('Scope', s.plugin.scope));
    dl.append(...row('Install path', code(s.plugin.installPath)));
  }
  dl.append(...row('Provides', `${items.length} item${items.length === 1 ? '' : 's'}`));
  return [h('h2', null, s.label), dl];
}

function side(it: Item | undefined, id: string, m: AtlasModel): HTMLElement {
  if (!it) return h('div', { class: 'side' }, id);
  const src = m.sources.find((s) => s.id === it.sourceId);
  return h(
    'div',
    { class: 'side' },
    h('h3', null, it.name),
    h('div', { class: 'muted' }, `${it.fullName} · ${src?.label ?? it.sourceId}${it.enabled ? '' : ' · off'}${it.ghost ? ' · candidate' : ''}`),
    firedText(it) ? h('div', { class: 'muted' }, firedText(it)) : null,
    it.description ? h('p', { class: 'desc' }, it.description) : h('p', { class: 'muted' }, '(no description)'),
  );
}

function renderEdge(e: Edge, ctx: PanelCtx): HTMLElement[] {
  const m = ctx.model;
  const byId = new Map(m.items.map((i) => [i.id, i]));
  const lookup = (id: string): Item | undefined => byId.get(id);
  if (e.kind === 'competes' && e.competes) {
    const c = e.competes;
    const out: HTMLElement[] = [h('h2', null, 'Competes'), h('div', { class: 'pair' }, side(lookup(e.from), e.from, m), side(lookup(e.to), e.to, m))];
    out.push(h('h3', null, 'Why they compete'), h('ul', null, ...c.reasons.map((r) => h('li', null, reasonText(r, c.score)))));
    out.push(h('p', { class: 'muted' }, `Strength ${c.strength}${defaultCompetes(m.edges, m.items).has(e.id) ? '' : ' — hidden by default; turn on “Show all competes” to draw it'}`));
    out.push(h('h3', null, 'What tilts it'));
    out.push(c.tilt.length ? h('ul', { class: 'tilt' }, ...c.tilt.map((t) => h('li', null, tiltText(t, lookup)))) : h('p', { class: 'muted' }, 'Nothing obvious tilts this contest.'));
    if (c.judge) {
      out.push(h('h3', null, 'Claude’s judgement'), h('p', null, c.judge.same ? 'Would be chosen for the same request. ' : 'Would be chosen for different requests. ', h('span', { class: 'muted' }, c.judge.why)));
    }
    return out;
  }
  if (e.kind === 'injects') {
    const hk = lookup(e.from);
    return [h('h2', null, 'Injects into every session'), h('p', null, `${hk?.fullName ?? e.from} (${hk?.hook?.event ?? 'hook'}) injects instructions into every session.`)];
  }
  const src = m.sources.find((s) => s.id === e.from);
  return [h('h2', null, 'Provides'), h('p', null, `${src?.label ?? e.from} provides ${lookup(e.to)?.name ?? e.to}.`)];
}

function renderSession(ctx: PanelCtx): HTMLElement[] {
  const m = ctx.model;
  const byId = new Map(m.items.map((i) => [i.id, i]));
  const hooks = m.edges.filter((e) => e.kind === 'injects' && e.to === EVERY_SESSION_ID).map((e) => byId.get(e.from)).filter((i): i is Item => !!i);
  return [
    h('h2', null, 'Every session'),
    h('p', null, 'SessionStart and UserPromptSubmit hooks run in every session. Whatever they print is added to Claude’s context — hidden influence on which skill Claude picks.'),
    h(
      'ul',
      null,
      ...hooks.map((hk) => {
        const src = m.sources.find((s) => s.id === hk.sourceId);
        return h('li', null, itemLink(hk, hk.id, ctx), ` — ${hk.hook?.event ?? ''} hook from ${src?.label ?? hk.sourceId}${hk.ghost ? ' (candidate)' : ''}${hk.enabled ? '' : ' (off)'}`);
      }),
    ),
  ];
}

function legend(): HTMLElement {
  const entry = (cls: string, text: string): HTMLElement => h('li', null, h('span', { class: cls }), text);
  return h(
    'div',
    { class: 'legend' },
    h('h3', null, 'Legend'),
    h(
      'ul',
      null,
      entry('lg-line provides', 'source provides item'),
      entry('lg-line competes', 'competes — both items on (strongest pairs by default)'),
      entry('lg-line competes weak', 'competes — one item is off (with “Show all competes”)'),
      entry('lg-line injects', 'hook injects into every session'),
      entry('lg-box traced', 'made by a plugin’s setup (outline in the plugin’s color)'),
      entry('lg-box ghost', 'candidate (not installed), or conditional instructions'),
      entry('lg-box off', 'turned off'),
      h('li', null, h('b', { class: 'lg-count' }, '3×'), 'times Claude chose it (last 30 days)'),
    ),
    h('p', { class: 'muted' }, 'Shapes: rounded = skill, barrel = agent, cut corner = command, tag = hook, hexagon = MCP server, square = instruction file.'),
  );
}

export function renderPanel(container: HTMLElement, sel: Selection, ctx: PanelCtx): void {
  const m = ctx.model;
  let content: HTMLElement[];
  if (!sel) {
    content = [
      h('h2', null, 'Claude Atlas'),
      h('p', { class: 'muted' }, 'Click a node to see where it comes from. Click a red dashed line to see why two items compete and what tilts the contest. Hover to highlight a node’s neighbours.'),
      legend(),
    ];
  } else if (sel.type === 'edge') {
    const e = m.edges.find((x) => x.id === sel.id);
    content = e ? renderEdge(e, ctx) : [];
  } else if (sel.id === EVERY_SESSION_ID) content = renderSession(ctx);
  else {
    const it = m.items.find((i) => i.id === sel.id);
    const s = it ? undefined : m.sources.find((x) => x.id === sel.id);
    content = it ? renderItem(it, ctx) : s ? renderSource(s, ctx) : [];
  }
  container.replaceChildren(...content);
  container.scrollTop = 0;
}

export function renderWarnings(container: HTMLElement, warnings: string[]): void {
  if (!warnings.length) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.replaceChildren(h('details', null, h('summary', null, `Warnings (${warnings.length})`), h('ul', null, ...warnings.map((w) => h('li', null, w)))));
}
