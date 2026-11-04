// App wiring: toolbar actions, model loading, filters -> map -> panel.
import type { AtlasModel } from '../src/model.js';
import { api, ApiError, token, type CandidateInput, type JudgeCapability, type ProjectEntry } from './api.js';
import { defaultFilters, toElements, type Filters } from './graph.js';
import { renderFilters } from './filters.js';
import { createMap } from './map.js';
import { h, renderPanel, renderWarnings, type Selection } from './panel.js';
import { OTHER, pickerOptions, switchProject } from './project.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  project: $<HTMLSelectElement>('project'),
  pathForm: $<HTMLFormElement>('path-form'),
  pathInput: $<HTMLInputElement>('path-input'),
  rescan: $<HTMLButtonElement>('rescan'),
  mcp: $<HTMLButtonElement>('mcp-live'),
  candidate: $<HTMLButtonElement>('candidate'),
  judge: $<HTMLButtonElement>('judge'),
  status: $('status'),
  filters: $('filters'),
  banner: $('candidate-banner'),
  error: $('error'),
  panel: $('panel'),
  warnings: $('warnings'),
  dialog: $<HTMLDialogElement>('candidate-dialog'),
  cform: $<HTMLFormElement>('candidate-form'),
  cerror: $('candidate-error'),
  csubmit: $<HTMLButtonElement>('candidate-submit'),
  ccancel: $<HTMLButtonElement>('candidate-cancel'),
};

const state: {
  project: string | null;
  model: AtlasModel | null;
  filters: Filters | null;
  selection: Selection;
  capability: JudgeCapability | null;
  busy: boolean;
} = { project: null, model: null, filters: null, selection: null, capability: null, busy: false };

const map = createMap($('map'), (t) => {
  state.selection = t;
  drawPanel();
});

function drawPanel(): void {
  if (!state.model) return;
  renderPanel(ui.panel, state.selection, {
    model: state.model,
    select: (sel) => {
      state.selection = sel;
      map.select(sel?.id ?? null);
      drawPanel();
    },
  });
}

function showError(msg: string | null): void {
  ui.error.hidden = !msg;
  ui.error.textContent = msg ?? '';
}

function setBusy(busy: boolean, label = ''): void {
  state.busy = busy;
  for (const b of [ui.rescan, ui.mcp, ui.candidate, ui.project]) b.disabled = busy || (b !== ui.project && !state.project);
  ui.judge.disabled = busy || !state.project || !state.capability?.available;
  if (busy) ui.status.textContent = label;
}

function updateJudgeButton(): void {
  const cap = state.capability;
  ui.judge.disabled = state.busy || !state.project || !cap?.available;
  ui.judge.title = cap && !cap.available ? (cap.reason ?? 'Unavailable') : 'Asks your claude CLI, run in isolation (no hooks, plugins or MCP), whether each competing pair would be chosen for the same request.';
}

function statusLine(m: AtlasModel): string {
  const competes = m.edges.filter((e) => e.kind === 'competes');
  const live = competes.filter((e) => {
    const a = m.items.find((i) => i.id === e.from);
    const b = m.items.find((i) => i.id === e.to);
    return a?.enabled && b?.enabled;
  }).length;
  const injects = m.edges.filter((e) => e.kind === 'injects').length;
  return `${m.items.length} items · ${competes.length} competes (${live} between enabled items) · ${injects} every-session hook${injects === 1 ? '' : 's'} · scanned ${new Date(m.scannedAt).toLocaleTimeString()}`;
}

function drawMap(refit: boolean): void {
  if (!state.model || !state.filters) return;
  map.setElements(toElements(state.model, state.filters), { refit });
}

function setModel(m: AtlasModel): void {
  const prev = state.model;
  const prevF = state.filters;
  state.model = m;
  // Keep the user's filter choices across rescans; new sources start visible.
  const f = defaultFilters(m);
  if (prevF && prev) {
    const prevIds = new Set(prev.sources.map((s) => s.id));
    f.kinds = new Set(prevF.kinds);
    f.showDisabled = prevF.showDisabled;
    f.search = prevF.search;
    f.sources = new Set(m.sources.map((s) => s.id).filter((id) => prevF.sources.has(id) || !prevIds.has(id)));
  }
  state.filters = f;
  renderFilters(ui.filters, m, f, ({ filters, relayout }) => {
    state.filters = filters;
    drawMap(relayout);
  });
  const cand = m.sources.filter((s) => s.kind === 'candidate');
  ui.banner.hidden = cand.length === 0;
  if (cand.length) {
    const hooks = m.items.filter((i) => i.ghost && i.kind === 'hook').length;
    const clear = h('button', { type: 'button' }, 'Clear candidate');
    clear.addEventListener('click', () => void run('Loading…', () => api.model(state.project!)));
    ui.banner.replaceChildren(
      `Showing ${cand.map((s) => s.label).join(', ')} as ghost nodes — nothing is installed. `,
      hooks ? h('strong', null, `It has ${hooks} hook${hooks === 1 ? '' : 's'}: this would inject instructions into every session. `) : '',
      h('span', { class: 'muted' }, 'Rescan, Check live MCP status and Ask Claude to judge also clear the candidate view. '),
      clear,
    );
  }
  renderWarnings(ui.warnings, m.warnings);
  ui.status.textContent = statusLine(m);
  drawMap(true);
  drawPanel();
}

async function run(label: string, fn: () => Promise<AtlasModel>): Promise<boolean> {
  if (!state.project) return false;
  setBusy(true, label);
  showError(null);
  try {
    setModel(await fn());
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body && typeof e.body === 'object' && 'available' in e.body) {
      state.capability = e.body as JudgeCapability;
      showError(`Ask Claude to judge is unavailable: ${state.capability.reason ?? 'unknown reason'}`);
    } else showError(e instanceof Error ? e.message : String(e));
    if (state.model) ui.status.textContent = statusLine(state.model);
    else ui.status.textContent = '';
    return false;
  } finally {
    setBusy(false);
    updateJudgeButton();
  }
}

/** Switches only when the new project's model loads; on failure the previous project stays fully in effect. */
async function openProject(path: string): Promise<void> {
  setBusy(true, 'Scanning…');
  showError(null);
  const prev = { project: state.project, model: state.model, filters: state.filters, selection: state.selection };
  const r = await switchProject(prev, path, (p) => api.model(p));
  if (r.ok && r.view.model) {
    state.project = r.view.project;
    state.selection = null;
    state.model = null;
    state.filters = null;
    setModel(r.view.model);
  } else {
    showError(r.error);
    ui.status.textContent = state.model ? statusLine(state.model) : '';
  }
  fillProjects(projects, state.project);
  if (!state.project) {
    ui.project.value = OTHER;
    ui.pathForm.hidden = false;
  }
  setBusy(false);
  updateJudgeButton();
}

function fillProjects(list: ProjectEntry[], selected: string | null): void {
  ui.project.replaceChildren(
    ...pickerOptions(list, selected).map((o) => {
      const el = h('option', o.title ? { value: o.value, title: o.title } : { value: o.value }, o.label);
      el.selected = o.value === selected;
      return el;
    }),
  );
}

let projects: ProjectEntry[] = [];
ui.project.addEventListener('change', () => {
  if (ui.project.value === OTHER) {
    ui.pathForm.hidden = false;
    ui.pathInput.focus();
    return;
  }
  ui.pathForm.hidden = true;
  void openProject(ui.project.value);
});
ui.pathForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const p = ui.pathInput.value.trim();
  if (!p) return;
  ui.pathForm.hidden = true;
  void openProject(p);
});

$('fit').addEventListener('click', () => map.fitAll());
ui.rescan.addEventListener('click', () => void run('Rescanning…', () => api.rescan(state.project!)));
ui.mcp.addEventListener('click', () => void run('Checking live MCP status (starting servers)…', () => api.mcpLive(state.project!)));
ui.judge.addEventListener('click', () => void run('Asking Claude to judge…', () => api.judge(state.project!)));

// Candidate dialog.
const kindSections = Array.from(ui.cform.querySelectorAll<HTMLElement>('[data-kind]'));
const ckind = (): string => (ui.cform.querySelector<HTMLInputElement>('input[name="ckind"]:checked')?.value ?? 'path');
const syncKind = (): void => {
  for (const s of kindSections) s.hidden = s.dataset.kind !== ckind();
};
ui.cform.addEventListener('change', syncKind);
ui.candidate.addEventListener('click', () => {
  ui.cerror.hidden = true;
  syncKind();
  ui.dialog.showModal();
});
ui.ccancel.addEventListener('click', () => ui.dialog.close());
ui.cform.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const val = (n: string): string => ((ui.cform.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
  let input: CandidateInput | null = null;
  const k = ckind();
  if (k === 'path' && val('path')) input = { kind: 'path', path: val('path') };
  if (k === 'git' && val('url')) input = { kind: 'git', url: val('url') };
  if (k === 'marketplace' && val('marketplace') && val('plugin')) input = { kind: 'marketplace', marketplace: val('marketplace'), plugin: val('plugin') };
  if (!input) {
    ui.cerror.hidden = false;
    ui.cerror.textContent = 'Fill in the field for the chosen kind.';
    return;
  }
  const chosen = input;
  ui.csubmit.disabled = true;
  ui.cerror.hidden = true;
  void (async () => {
    setBusy(true, chosen.kind === 'path' ? 'Loading candidate…' : 'Cloning candidate…');
    try {
      const m = await api.candidate(state.project!, chosen);
      ui.dialog.close();
      setModel(m);
    } catch (e) {
      ui.cerror.hidden = false;
      ui.cerror.textContent = e instanceof Error ? e.message : String(e);
      if (state.model) ui.status.textContent = statusLine(state.model);
    } finally {
      ui.csubmit.disabled = false;
      setBusy(false);
      updateJudgeButton();
    }
  })();
});

async function init(): Promise<void> {
  renderPanel(ui.panel, null, { model: { project: '', scannedAt: '', sources: [], items: [], edges: [], warnings: [] }, select: () => undefined });
  if (!token) {
    showError('Missing access token. Open the URL that claude-atlas printed in your terminal.');
    setBusy(true);
    ui.status.textContent = '';
    return;
  }
  setBusy(true, 'Loading projects…');
  try {
    const [list, cap] = await Promise.all([
      api.projects(),
      api.judgeCapability().catch((e: unknown): JudgeCapability => ({ available: false, reason: `Could not check: ${e instanceof Error ? e.message : String(e)}`, args: [] })),
    ]);
    projects = list;
    state.capability = cap;
    fillProjects(list, null);
    setBusy(false);
    updateJudgeButton();
    if (list[0]) await openProject(list[0].path);
    else {
      ui.status.textContent = 'No projects found. Choose “Enter a path…” to pick one.';
      ui.project.value = OTHER;
      ui.pathForm.hidden = false;
    }
  } catch (e) {
    setBusy(false);
    showError(e instanceof Error ? e.message : String(e));
  }
}

void init();
