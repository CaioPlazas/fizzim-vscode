// The edit bar: a slim, always-present strip between the toolbar and the canvas
// that shows the selected object's common fields and edits them live — an
// Excel-formula-bar for the diagram. Fixed position (no floating, no modal, no
// mode error), so it satisfies the brief: the canvas stays spatial, editing
// happens on a stable surface you never have to travel to hunt for.
//
// Live editing, undo-safe: `input` mutates the model and repaints (no persist,
// so a rename isn't six undo steps); `change` (blur / Enter / a select or
// checkbox) commits one undo step. Rename / reconnect act only on `change` and
// revert the field if rejected. Same edit.ts mutations as everywhere else.
//
// A state with many outputs makes the row long; rather than only scrolling
// sideways, the bar can EXPAND vertically (fields wrap to multiple rows) and the
// expansion is PINNED — it stays on across selections until toggled off. The
// pin state lives in the closure, so it survives selection changes for the whole
// session.
//
// The bar rebuilds only when the selection identity changes (or the pin
// toggles), so it never steals focus mid-edit or churns during a drag.

import { FzmDocument, FzmLoopback, FzmTransition } from '../fzm/model';
import type { Selection } from './hitTest';
import {
  colorIntToHex,
  getAttrValue,
  getPriority,
  getTransitionOutputValue,
  hexToColorInt,
  reconnectLoopback,
  reconnectTransition,
  renameState,
  renameTransition,
  setEquation,
  setPriority,
  setResetState,
  setStateOutputValue,
  setTransitionOutputValue,
  setTransitionStub,
  stateOutputAttributes,
} from './edit';

export interface EditBarHost {
  getDoc(): FzmDocument;
  getSelection(): Selection | null;
  getGroup(): Selection[];
  redraw(): void; // live repaint, no persist
  commit(): void; // persist one undo step
  message(msg: string): void;
  /** Open the full attribute table for the current object (the rare long tail). */
  openAllAttributes(sel: Selection): void;
  /** The persisted expand/pin state and a setter (a view pref, not in the .fzm). */
  getExpanded(): boolean;
  setExpanded(v: boolean): void;
}

// --- compact horizontal field builders --------------------------------------

function field(label: string, control: HTMLElement): HTMLElement {
  const f = document.createElement('label');
  f.className = 'eb-field';
  const l = document.createElement('span');
  l.className = 'eb-label';
  l.textContent = label;
  f.append(l, control);
  return f;
}

function textInput(value: string, width: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'eb-input';
  i.value = value;
  i.style.width = width;
  return i;
}

function checkbox(checked: boolean): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.className = 'eb-check';
  i.checked = checked;
  return i;
}

function select(value: string, options: string[]): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'eb-input eb-select';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    s.append(o);
  }
  return s;
}

function colorSwatch(value: string, onInput: (hex: string) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'color';
  i.className = 'eb-color';
  i.value = value;
  i.title = 'Color';
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'eb-sep';
  return s;
}

// --- the bar ----------------------------------------------------------------

export function buildEditBar(container: HTMLElement, host: EditBarHost): { refresh(): void } {
  let lastKey = ' ';
  // Pinned vertical expansion. Seeded from the persisted view pref and written
  // back on toggle, so the pin survives selection changes AND reloads.
  let expanded = host.getExpanded();

  const keyOf = (): string => {
    const g = host.getGroup();
    if (g.length > 1) return 'group:' + g.length;
    const sel = host.getSelection();
    return sel ? `${sel.kind}:${sel.index}` : 'none';
  };

  // Commit-on-change wiring shared by the simple value fields.
  const live = (input: HTMLInputElement, apply: (v: string) => void) => {
    input.addEventListener('input', () => { apply(input.value); host.redraw(); });
    input.addEventListener('change', () => host.commit());
  };

  const hint = (text: string): HTMLElement => {
    const s = document.createElement('span');
    s.className = 'eb-hint';
    s.textContent = text;
    return s;
  };

  const buildState = (doc: FzmDocument, sel: Selection): HTMLElement[] => {
    const s = doc.states[sel.index];
    if (!s) return [];
    const parts: HTMLElement[] = [];

    const tag = document.createElement('span');
    tag.className = 'eb-kind';
    tag.textContent = 'State';
    parts.push(tag);

    const name = textInput(getAttrValue(s.attributes, 'name'), '10ch');
    name.addEventListener('change', () => {
      const r = renameState(doc, sel.index, name.value.trim());
      if (!r.ok) { host.message(r.error!); name.value = getAttrValue(s.attributes, 'name'); return; }
      host.redraw();
      host.commit();
    });
    parts.push(field('Name', name));

    const reset = checkbox(s.reset);
    reset.addEventListener('change', () => { setResetState(doc, sel.index, reset.checked); host.redraw(); host.commit(); });
    parts.push(field('Reset', reset));

    parts.push(field('Color', colorControl(colorIntToHex(s.color), (hex) => { s.color = hexToColorInt(hex); })));

    const outs = stateOutputAttributes(s);
    if (outs.length) {
      parts.push(sep());
      for (const o of outs) {
        const def = doc.outputs.find((x) => x.name === o.name)?.value ?? '';
        const inp = textInput(o.value, '5ch');
        inp.placeholder = def || '0';
        live(inp, (v) => setStateOutputValue(s, o.name, v));
        parts.push(field(o.name, inp));
      }
    }
    return parts;
  };

  const buildTransition = (doc: FzmDocument, sel: Selection): HTMLElement[] => {
    const t = doc.transitions[sel.index];
    if (!t) return [];
    const isLoop = t.kind === 'loopback';
    const names = doc.states.map((st) => st.name);
    const parts: HTMLElement[] = [];

    const tag = document.createElement('span');
    tag.className = 'eb-kind';
    tag.textContent = isLoop ? 'Loopback' : 'Transition';
    parts.push(tag);

    const eq = textInput(getAttrValue(t.attributes, 'equation'), '12ch');
    live(eq, (v) => setEquation(t, v));
    parts.push(field('Equation', eq));

    const prio = textInput(getPriority(t), '4ch');
    live(prio, (v) => setPriority(t, v));
    parts.push(field('Priority', prio));

    if (!isLoop) {
      const tr = t as FzmTransition;
      const start = select(tr.startState, names);
      const end = select(tr.endState, names);
      const reconnect = (changed: HTMLSelectElement) => {
        const r = reconnectTransition(doc, sel.index, start.value, end.value);
        if (!r.ok) { host.message(r.error!); changed.value = changed === start ? tr.startState : tr.endState; return; }
        host.redraw();
        host.commit();
      };
      start.addEventListener('change', () => reconnect(start));
      end.addEventListener('change', () => reconnect(end));
      parts.push(field('From', start), field('To', end));

      const stub = checkbox(tr.stub);
      stub.addEventListener('change', () => { setTransitionStub(doc, tr, stub.checked); host.redraw(); host.commit(); });
      parts.push(field('Stub', stub));
    } else {
      const stName = (t as FzmLoopback).state;
      const st = select(stName, names);
      st.addEventListener('change', () => {
        const r = reconnectLoopback(doc, sel.index, st.value);
        if (!r.ok) { host.message(r.error!); st.value = stName; return; }
        host.redraw();
        host.commit();
      });
      parts.push(field('State', st));
    }

    parts.push(field('Color', colorControl(colorIntToHex(t.color), (hex) => { t.color = hexToColorInt(hex); })));

    if (doc.outputs.length) {
      parts.push(sep());
      for (const o of doc.outputs) {
        const inp = textInput(getTransitionOutputValue(t, o.name), '5ch');
        inp.placeholder = '–';
        live(inp, (v) => setTransitionOutputValue(t, o.name, v));
        parts.push(field(o.name, inp));
      }
    }
    return parts;
  };

  const buildText = (doc: FzmDocument, sel: Selection): HTMLElement[] => {
    const txt = doc.texts[sel.index];
    if (!txt) return [];
    if (txt.isGlobalTable) return [hint('Global table — edit it in Global Attributes')];
    const tag = document.createElement('span');
    tag.className = 'eb-kind';
    tag.textContent = 'Text';
    const inp = textInput(txt.text ?? '', '24ch');
    live(inp, (v) => { txt.text = v; });
    return [tag, field('Content', inp)];
  };

  // A colour swatch that repaints live and commits on the picker's change.
  const colorControl = (value: string, onInput: (hex: string) => void): HTMLElement => {
    const sw = colorSwatch(value, (hex) => { onInput(hex); host.redraw(); });
    sw.addEventListener('change', () => host.commit());
    return sw;
  };

  // The pin/expand toggle. One control: on = the fields wrap to multiple rows
  // and it stays that way across selections; off = single paged row.
  const expandToggle = (): HTMLElement => {
    const b = document.createElement('button');
    b.className = 'eb-icon' + (expanded ? ' active' : '');
    b.title = expanded ? 'Collapse to one row' : 'Expand to rows (stays pinned)';
    b.innerHTML = `<span class="codicon codicon-${expanded ? 'chevron-up' : 'chevron-down'}"></span>`;
    b.addEventListener('click', () => { expanded = !expanded; host.setExpanded(expanded); build(); });
    return b;
  };

  const allAttrsButton = (sel: Selection): HTMLElement => {
    const b = document.createElement('button');
    b.className = 'eb-more';
    b.textContent = 'All attributes…';
    b.title = 'Open the full attribute table';
    b.addEventListener('click', () => host.openAllAttributes(sel));
    return b;
  };

  const pagerButton = (dir: -1 | 1): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'eb-pager';
    b.title = dir < 0 ? 'Previous fields' : 'More fields';
    b.innerHTML = `<span class="codicon codicon-chevron-${dir < 0 ? 'left' : 'right'}"></span>`;
    b.addEventListener('click', () => {
      if (!contentEl) return;
      const step = Math.max(80, contentEl.clientWidth * 0.8);
      contentEl.scrollBy({ left: dir * step, behavior: 'smooth' });
    });
    return b;
  };

  // The pager arrows only appear when the row is collapsed AND its fields
  // overflow — small states never see them; the expanded (wrapped) bar never
  // does either. Disabled at the ends. Recomputed on scroll and on resize.
  let contentEl: HTMLElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  const updatePager = () => {
    if (!contentEl || !prevBtn || !nextBtn) return;
    const overflow = !expanded && contentEl.scrollWidth > contentEl.clientWidth + 1;
    prevBtn.style.display = overflow ? '' : 'none';
    nextBtn.style.display = overflow ? '' : 'none';
    if (overflow) {
      prevBtn.disabled = contentEl.scrollLeft <= 0;
      nextBtn.disabled = contentEl.scrollLeft + contentEl.clientWidth >= contentEl.scrollWidth - 1;
    }
  };
  window.addEventListener('resize', updatePager);

  const build = () => {
    container.classList.toggle('expanded', expanded);
    const doc = host.getDoc();
    const sel = host.getSelection();
    const group = host.getGroup();

    const content = document.createElement('div');
    content.className = 'eb-content';
    content.addEventListener('scroll', updatePager);
    contentEl = content;

    let selForActions: Selection | null = null;
    if (group.length > 1) {
      content.append(hint(`${group.length} objects selected`));
    } else if (!sel) {
      content.append(hint('No selection — click an object to edit it'));
    } else if (sel.kind === 'state') {
      content.append(...buildState(doc, sel));
      selForActions = sel;
    } else if (sel.kind === 'transition') {
      content.append(...buildTransition(doc, sel));
      selForActions = sel;
    } else if (sel.kind === 'text') {
      content.append(...buildText(doc, sel));
      if (!doc.texts[sel.index]?.isGlobalTable) selForActions = sel;
    }

    // Layout: [‹] [fields] [›] | [expand] [All attributes…]. The pager arrows
    // flank the fields (shown only on overflow); the actions stay put whether
    // the bar is one paged row or many wrapped ones.
    const children: HTMLElement[] = [];
    if (selForActions) {
      prevBtn = pagerButton(-1);
      nextBtn = pagerButton(1);
      children.push(prevBtn, content, nextBtn);
      const actions = document.createElement('div');
      actions.className = 'eb-actions';
      actions.append(expandToggle(), allAttrsButton(selForActions));
      children.push(actions);
    } else {
      prevBtn = nextBtn = null;
      children.push(content);
    }
    container.replaceChildren(...children);
    // Overflow can only be measured after layout.
    requestAnimationFrame(updatePager);
  };

  return {
    refresh() {
      const key = keyOf();
      if (key === lastKey) return;
      lastKey = key;
      build();
    },
  };
}
