// Filter controls: kinds, sources, "show disabled" and search. Calls onChange with a fresh Filters object.
import type { AtlasModel } from '../src/model.js';
import { ALL_KINDS, KIND_LABELS, sourceColors, type Filters } from './graph.js';
import { h } from './panel.js';

export type FilterChange = { filters: Filters; relayout: boolean };

export function renderFilters(container: HTMLElement, m: AtlasModel, current: Filters, onChange: (c: FilterChange) => void): void {
  const f: Filters = { kinds: new Set(current.kinds), sources: new Set(current.sources), showDisabled: current.showDisabled, search: current.search };
  const emit = (relayout: boolean): void => onChange({ filters: { kinds: new Set(f.kinds), sources: new Set(f.sources), showDisabled: f.showDisabled, search: f.search }, relayout });

  const checkbox = (label: Node | string, checked: boolean, on: (v: boolean) => void, cls = 'chip'): HTMLLabelElement => {
    const input = h('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => on(input.checked));
    return h('label', { class: cls }, input, label);
  };

  const kinds = h('div', { class: 'group', role: 'group', 'aria-label': 'Kinds' });
  for (const k of ALL_KINDS) {
    kinds.append(
      checkbox(KIND_LABELS[k], f.kinds.has(k), (v) => {
        if (v) f.kinds.add(k);
        else f.kinds.delete(k);
        emit(true);
      }),
    );
  }

  const srcList = h('div', { class: 'src-list' });
  const srcBoxes: HTMLInputElement[] = [];
  const colors = sourceColors(m);
  for (const s of m.sources) {
    const sw = h('span', { class: 'swatch' });
    sw.style.background = colors.get(s.id) ?? '#999';
    const lab = checkbox(
      h('span', null, sw, ` ${s.label}${s.enabled ? '' : ' (off)'}`),
      f.sources.has(s.id),
      (v) => {
        if (v) f.sources.add(s.id);
        else f.sources.delete(s.id);
        summary.textContent = sourcesSummary();
        emit(true);
      },
      'src-row',
    );
    srcBoxes.push(lab.querySelector('input')!);
    srcList.append(lab);
  }
  const sourcesSummary = (): string => `Sources (${f.sources.size}/${m.sources.length})`;
  const summary = h('summary', null, sourcesSummary());
  const all = h('button', { type: 'button' }, 'All');
  const none = h('button', { type: 'button' }, 'None');
  const setAll = (v: boolean): void => {
    f.sources = new Set(v ? m.sources.map((s) => s.id) : []);
    for (const b of srcBoxes) b.checked = v;
    summary.textContent = sourcesSummary();
    emit(true);
  };
  all.addEventListener('click', () => setAll(true));
  none.addEventListener('click', () => setAll(false));
  const sources = h('details', { class: 'sources' }, summary, h('div', { class: 'src-pop' }, h('div', { class: 'src-actions' }, all, none), srcList));

  const disabled = checkbox(
    'Show disabled',
    f.showDisabled,
    (v) => {
      f.showDisabled = v;
      emit(true);
    },
    'chip toggle',
  );

  const search = h('input', { type: 'search', placeholder: 'Search names…', 'aria-label': 'Search' });
  search.value = f.search;
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      f.search = search.value;
      emit(false);
    }, 150);
  });

  container.replaceChildren(kinds, sources, disabled, search);
}
