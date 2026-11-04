import { describe, expect, it } from 'vitest';
import type { Item, Tilt } from '../../src/model.js';
import { madeByText, reasonText, tiltText } from '../../web/panel.js';

const it1 = { id: 'a', name: 'brainstorming', fullName: 'superpowers:brainstorming', kind: 'skill' } as Item;
const lookup = (id: string): Item | undefined => (id === 'a' ? it1 : undefined);

describe('plain-words tilt and reasons', () => {
  it('hook-injects names the favoured item and says the hook injects instructions into every session', () => {
    const t: Tilt = { itemId: 'a', kind: 'hook-injects', detail: 'superpowers SessionStart hook injects skill-use instructions into every session' };
    const text = tiltText(t, lookup);
    expect(text).toContain('injects instructions into every session');
    expect(text).toContain('brainstorming');
  });

  it('imperative-wording favours the item; disabled names the item that is off', () => {
    expect(tiltText({ itemId: 'a', kind: 'imperative-wording', detail: '' }, lookup)).toMatch(/brainstorming.*(MUST|Use when)/);
    expect(tiltText({ itemId: 'a', kind: 'disabled', detail: '' }, lookup)).toMatch(/superpowers:brainstorming is turned off/);
  });

  it('describes reasons in plain words', () => {
    expect(reasonText('phase:design', 0)).toMatch(/design phase/);
    expect(reasonText('name-collision', 0)).toMatch(/same short name/i);
    expect(reasonText('similar-description', 0.42)).toMatch(/42%/);
  });

  it('made-by text names the template when the copy was renamed', () => {
    expect(madeByText({ plugin: 'rpi', version: '5.0.0', similarity: 0.93, edited: true, renamed: true, template: 'design' })).toBe(
      'made by rpi setup, renamed from design, 93% match, edited (template version 5.0.0)',
    );
    expect(madeByText({ plugin: 'rpi', version: '5.0.0', similarity: 1, edited: false })).toBe('made by rpi setup, 100% match (template version 5.0.0)');
  });
});
