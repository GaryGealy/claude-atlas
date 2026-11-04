// Cytoscape instance, stylesheet and hover/select highlighting. Positions come precomputed from graph.ts (preset layout).
import cytoscape, { type Core, type ElementDefinition, type EventObject, type StylesheetStyle } from 'cytoscape';
import { LAYOUT } from './graph.js';

declare global {
  interface Window {
    __atlasCy?: Core;
  }
}

const RED = '#dc2626';
const ITEM_W = LAYOUT.cellW - 12;

// `outline-*` is supported by cytoscape >= 3.28 but missing from @types/cytoscape, hence the loose typing.
const STYLE = [
  {
    selector: 'node',
    style: {
      // Manual z-order: full-strength competes lines and hook arrows draw above nodes so they are never hidden
      // behind the grid; provides lines and faint competes lines stay underneath.
      'z-index-compare': 'manual',
      'z-index': 10,
      label: 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'ellipsis',
      'min-zoomed-font-size': 4,
      'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
    },
  },
  {
    selector: 'node.source',
    style: {
      shape: 'round-rectangle',
      width: 180,
      height: 28,
      'background-color': 'data(color)',
      color: '#fff',
      'font-size': 12,
      'font-weight': 600,
      'text-max-width': 168,
    },
  },
  { selector: 'node.source.disabled', style: { 'background-color': '#9ca3af', 'border-width': 3, 'border-color': 'data(color)' } },
  {
    selector: 'node.item',
    style: {
      shape: 'round-rectangle',
      width: ITEM_W,
      height: 26,
      'background-color': 'data(fill)',
      'border-width': 1.5,
      'border-color': 'data(color)',
      color: '#1f2937',
      'font-size': 11,
      'text-max-width': ITEM_W - 14,
    },
  },
  { selector: 'node.kind-agent', style: { shape: 'barrel' } },
  { selector: 'node.kind-command', style: { shape: 'cut-rectangle' } },
  { selector: 'node.kind-hook', style: { shape: 'tag', 'border-width': 2 } },
  { selector: 'node.kind-mcp-server', style: { shape: 'round-hexagon' } },
  { selector: 'node.kind-instruction', style: { shape: 'rectangle' } },
  { selector: 'node.kind-memory', style: { shape: 'bottom-round-rectangle' } },
  { selector: 'node.fired', style: { 'font-weight': 700 } },
  { selector: 'node.conditional', style: { 'border-style': 'dashed' } },
  { selector: 'node.traced', style: { 'outline-width': 3, 'outline-color': 'data(traceColor)', 'outline-offset': 2, 'outline-opacity': 1 } },
  { selector: 'node.item.disabled', style: { 'background-color': '#f3f4f6', 'border-color': '#c4c9d1', color: '#9ca3af' } },
  { selector: 'node.ghost', style: { 'background-opacity': 0.35, 'border-style': 'dashed', 'border-width': 2, opacity: 0.8 } },
  {
    selector: 'node.every-session',
    style: {
      shape: 'ellipse',
      width: 120,
      height: 120,
      'background-color': '#fee2e2',
      'border-width': 3,
      'border-color': RED,
      color: '#991b1b',
      'font-size': 15,
      'font-weight': 700,
      'text-wrap': 'wrap',
      'text-max-width': 90,
    },
  },
  { selector: 'edge', style: { 'curve-style': 'bezier', width: 1, 'z-index-compare': 'manual' } },
  {
    selector: 'edge.provides',
    style: { 'curve-style': 'taxi', 'taxi-direction': 'rightward', 'taxi-turn': 40, 'line-color': '#cbd5e1', width: 0.75, opacity: 0.45, 'z-index': 1 },
  },
  {
    selector: 'edge.competes',
    style: {
      'curve-style': 'unbundled-bezier',
      'control-point-distances': 36,
      'control-point-weights': 0.5,
      'line-color': RED,
      'line-style': 'dashed',
      'line-dash-pattern': [7, 4],
      width: 1.8,
      opacity: 0.7,
      'z-index': 20,
    },
  },
  { selector: 'edge.competes.weak', style: { width: 1, opacity: 0.12, 'z-index': 2 } },
  { selector: 'edge.competes.judged-different', style: { width: 1.2, opacity: 0.4 } },
  {
    selector: 'edge.injects',
    style: { 'line-color': RED, width: 2.5, 'target-arrow-shape': 'triangle', 'target-arrow-color': RED, 'arrow-scale': 1.3, 'z-index': 20 },
  },
  { selector: 'node.faded', style: { opacity: 0.15 } },
  { selector: 'edge.faded', style: { opacity: 0.05 } },
  { selector: 'node.highlight', style: { opacity: 1 } },
  { selector: 'edge.highlight', style: { opacity: 1, 'z-index': 30 } },
  { selector: 'edge.competes.highlight', style: { width: 3 } },
  { selector: 'edge.provides.highlight', style: { 'line-color': '#94a3b8', width: 1.2 } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#111827' } },
  { selector: 'edge:selected', style: { width: 4, opacity: 1 } },
] as unknown as StylesheetStyle[];

// Below this zoom item labels are too small to read, so the initial view starts at the top instead of fitting everything.
const READABLE_ZOOM = 0.8;

export type MapHandle = {
  cy: Core;
  fitAll(): void;
  setElements(els: ElementDefinition[], opts: { refit: boolean }): void;
  select(id: string | null): void;
};

export function createMap(container: HTMLElement, onSelect: (target: { type: 'node' | 'edge'; id: string } | null) => void): MapHandle {
  const cy = cytoscape({
    container,
    style: STYLE,
    layout: { name: 'preset' },
    minZoom: 0.15,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autoungrabify: true,
    selectionType: 'single',
  });
  // R13: always exposed (the e2e test drives the production build through it).
  window.__atlasCy = cy;

  let baseFaded = new Set<string>(); // faded by search, restored after a hover/selection ends
  let selected: string | null = null;

  const restore = (): void => {
    cy.batch(() => {
      cy.elements().removeClass('faded highlight');
      cy.elements().filter((e) => baseFaded.has(e.id())).addClass('faded');
    });
  };
  const focus = (id: string): void => {
    const ele = cy.getElementById(id);
    if (ele.empty()) return restore();
    const keep: cytoscape.Collection = ele.isNode() ? ele.closedNeighborhood() : (ele as cytoscape.EdgeSingular).union((ele as cytoscape.EdgeSingular).connectedNodes());
    cy.batch(() => {
      cy.elements().removeClass('highlight').addClass('faded');
      keep.removeClass('faded').addClass('highlight');
    });
  };
  const initialView = (): void => {
    cy.fit(undefined, 30);
    if (cy.zoom() >= READABLE_ZOOM) return;
    const bb = cy.elements().boundingBox();
    const z = READABLE_ZOOM;
    cy.viewport({ zoom: z, pan: { x: Math.max(20, (cy.width() - bb.w * z) / 2) - bb.x1 * z, y: 20 - bb.y1 * z } });
  };
  const settle = (): void => (selected ? focus(selected) : restore());

  cy.on('mouseover', 'node', (ev: EventObject) => focus(ev.target.id()));
  cy.on('mouseout', 'node', settle);
  cy.on('tap', 'node, edge', (ev: EventObject) => {
    selected = ev.target.id();
    focus(selected!);
    onSelect({ type: ev.target.isNode() ? 'node' : 'edge', id: selected! });
  });
  cy.on('tap', (ev: EventObject) => {
    if (ev.target !== cy) return;
    selected = null;
    cy.elements().unselect();
    restore();
    onSelect(null);
  });

  return {
    cy,
    setElements(els, { refit }) {
      cy.batch(() => {
        cy.elements().remove();
        cy.add(els);
      });
      baseFaded = new Set(els.filter((e) => typeof e.classes === 'string' && /\bfaded\b/.test(e.classes)).map((e) => e.data.id!));
      if (selected && cy.getElementById(selected).nonempty()) {
        cy.getElementById(selected).select();
        focus(selected);
      } else {
        selected = null;
        restore();
      }
      if (refit) initialView();
    },
    fitAll() {
      cy.fit(undefined, 30);
    },
    select(id) {
      cy.elements().unselect();
      selected = id && cy.getElementById(id).nonempty() ? id : null;
      if (selected) {
        cy.getElementById(selected).select();
        focus(selected);
      } else restore();
    },
  };
}
