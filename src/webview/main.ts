import type { FzmDocument } from '../fzm/model';
import { parseFzm } from '../fzm/parser';
import { serializeFzm } from '../fzm/serializer';
import { AttrLabelTarget, computeBounds, hitAttrLabel, render, transitionOnPage } from './render';
import { crossPageSide, CurveHandle, hitTest, normRect, objectsInBox, Selection, StateHandle, stateHandleAt, transitionHandleAt } from './hitTest';
import { nearestBorderPoint, recomputeCrossPage, recomputeLoopback, recomputeStub, recomputeTransition } from './geometry';
import {
  applyAttributeEdits,
  colorIntToHex,
  createLoopback,
  createState,
  createText,
  createTransition,
  deletePage,
  deleteSelection,
  duplicateState,
  hexToColorInt,
  moveStateToPage,
  moveTextToPage,
  reconcileTransitionOutputs,
  reconnectLoopback,
  reconnectTransition,
  renameState,
  renameTransition,
  resizeState,
  sanitizeLocalOutputTypes,
  setResetState,
  setTransitionStub,
  snap,
  transitionDialogAttributes,
} from './edit';
import { showContextMenu } from './contextMenu';
import { promptText } from './textInput';
import { Field, showConfirm, showForm, showMessage } from './formDialog';
import { showAttributeDialog } from './attributeDialog';
import { showGlobalEditor } from './globalEditor';

declare global {
  interface Window {
    __FZM_TEXT__?: string;
  }
}
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

type DragState =
  | {
      kind: 'state';
      index: number;
      startMouseX: number;
      startMouseY: number;
      origX0: number;
      origY0: number;
      origX1: number;
      origY1: number;
    }
  | {
      kind: 'resize';
      index: number;
      handle: StateHandle;
      startMouseX: number;
      startMouseY: number;
      origX0: number;
      origY0: number;
      origX1: number;
      origY1: number;
    }
  | { kind: 'curve'; index: number; handle: CurveHandle }
  | { kind: 'attrLabel'; target: AttrLabelTarget; startMouseX: number; startMouseY: number; origX2: number; origY2: number }
  | { kind: 'text'; index: number; startMouseX: number; startMouseY: number; origX: number; origY: number }
  | { kind: 'marquee'; startMouseX: number; startMouseY: number }
  | {
      kind: 'group';
      startMouseX: number;
      startMouseY: number;
      orig: { sel: Selection; ox: number; oy: number; ow: number; oh: number }[];
    };

// Applies a transition/loopback handle drag: endpoints re-snap to the relevant
// state's border (36 points), control points move freely (like Java's
// StateTransitionObj.adjustShapeOrPosition).
function applyCurveHandle(doc: FzmDocument, t: FzmDocument['transitions'][number], handle: CurveHandle, x: number, y: number): void {
  // Stub: the tip (pageS) moves freely; the anchor re-snaps to the border and
  // drags the tip with it so the stub keeps its length/direction.
  if (handle === 'stubTip') {
    if (t.kind === 'transition') t.pageS = { x, y };
    return;
  }
  const byName = new Map(doc.states.map((s) => [s.name, s]));
  if (handle === 'start' && t.kind === 'transition' && t.stub) {
    const st = byName.get(t.startState);
    if (!st) return;
    const { point, index } = nearestBorderPoint(st, x, y);
    t.pageS = { x: t.pageS.x + (point.x - t.startPt.x), y: t.pageS.y + (point.y - t.startPt.y) };
    t.startPt = point;
    t.startStateIndex = index;
    return;
  }
  if (handle === 'startCtrl') {
    t.startCtrlPt = { x, y };
    return;
  }
  if (handle === 'endCtrl') {
    t.endCtrlPt = { x, y };
    return;
  }
  // Cross-page connector handles move freely (Java's PAGES/PAGESC/PAGEE/PAGEEC).
  if (t.kind === 'transition') {
    if (handle === 'pageS') {
      t.pageS = { x, y };
      return;
    }
    if (handle === 'pageSC') {
      t.pageSC = { x, y };
      return;
    }
    if (handle === 'pageE') {
      t.pageE = { x, y };
      return;
    }
    if (handle === 'pageEC') {
      t.pageEC = { x, y };
      return;
    }
  }
  const stateName = t.kind === 'loopback' ? t.state : handle === 'start' ? t.startState : t.endState;
  const st = byName.get(stateName);
  if (!st) return;
  const { point, index } = nearestBorderPoint(st, x, y);
  if (handle === 'start') {
    t.startPt = point;
    t.startStateIndex = index;
  } else {
    t.endPt = point;
    t.endStateIndex = index;
  }
}

function updateAttachedTransitions(doc: FzmDocument, movedName: string): void {
  const byName = new Map(doc.states.map((s) => [s.name, s]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') {
      if (t.state === movedName) {
        const state = byName.get(t.state);
        if (state) recomputeLoopback(t, state);
      }
    } else if (t.stub) {
      // A stub is anchored on its start state only; re-anchor when that moves.
      if (t.startState === movedName) {
        const startState = byName.get(t.startState);
        if (startState) recomputeStub(t, startState);
      }
    } else if (t.startState === movedName || t.endState === movedName) {
      const startState = byName.get(t.startState);
      const endState = byName.get(t.endState);
      if (startState && endState) {
        // Cross-page connectors re-dock to the page edge (Java re-runs
        // moveEndPts' cross-page branch whenever an endpoint state moves).
        if (startState.page !== endState.page) recomputeCrossPage(doc, t);
        else recomputeTransition(t, startState, endState);
      }
    }
  }
}

// Font families offered by the Preferences pickers (nobody remembers font names).
// Fizzim stores a Java font name in the .fzm, so whatever the file already has is
// kept as an option — opening a file with an unlisted font won't silently change it.
const FONT_CHOICES = [
  'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Times New Roman', 'Georgia', 'Courier New', 'Consolas', 'Lucida Console',
  'Comic Sans MS', 'Impact', 'SansSerif', 'Serif', 'Monospaced',
];
const fontOptions = (current: string): string[] =>
  current && !FONT_CHOICES.includes(current) ? [current, ...FONT_CHOICES] : FONT_CHOICES;

function main(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const initialText = window.__FZM_TEXT__;
  if (!canvas || initialText === undefined) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const vscode = acquireVsCodeApi();
  let page = 1;
  let doc = parseFzm(initialText);
  let selection: Selection | null = null;
  let group: Selection[] = []; // multi-selection (states + text)
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let drag: DragState | null = null;
  let dragMoved = false;
  let zoom = 1;

  const selKey = (s: Selection) => `${s.kind}:${s.index}`;
  const inGroup = (s: Selection) => group.some((g) => selKey(g) === selKey(s));

  // The diagram canvas uses a fixed white background by default, independent of
  // the VS Code theme (so it looks like paper / the original Fizzim). "Dark mode"
  // (toolbar toggle, persisted to the fizzim.darkMode setting) switches it to a
  // dark palette. render.ts maps default-black shapes to `fg` so they stay visible.
  let darkMode = (window as unknown as { __FZM_DARK__?: boolean }).__FZM_DARK__ === true;
  const themeColors = () => (darkMode ? { fg: '#d4d4d4', bg: '#1e1e1e' } : { fg: '#000000', bg: '#ffffff' });

  // Default colors for newly created objects (Fizzim's Pref defaults). Kept
  // outside the .fzm (app-level, like Fizzim) — seeded from the fizzim.default*
  // settings and editable from the Preferences dialog (persisted via the host).
  const rawDefaults = (window as unknown as { __FZM_DEFAULTS__?: { stateColor?: string; transitionColor?: string; loopbackColor?: string } }).__FZM_DEFAULTS__ ?? {};
  const defaults = {
    stateColor: hexToColorInt(rawDefaults.stateColor ?? '#000000'),
    transitionColor: hexToColorInt(rawDefaults.transitionColor ?? '#000000'),
    loopbackColor: hexToColorInt(rawDefaults.loopbackColor ?? '#000000'),
  };

  // The canvas is a true pixel surface at the page resolution (content-expanded)
  // times the zoom factor. Setting the CSS size equal to the buffer size makes
  // it display 1:1 and scroll inside #canvas-wrap, instead of being squished to
  // fit the viewport.
  const resize = () => {
    const { width, height } = computeBounds(doc, page);
    const w = Math.round(width * zoom);
    const h = Math.round(height * zoom);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };
  const countsEl = document.getElementById('counts');
  const updateCounts = () => {
    if (!countsEl) return;
    const s = doc.states.filter((o) => o.page === page).length;
    const t = doc.transitions.filter((o) => o.page === page).length;
    const pageInfo = doc.tabs.length > 1 ? ` · page ${page}/${doc.tabs.length}` : '';
    countsEl.textContent = `${s} states, ${t} transitions${pageInfo}`;
  };
  const redraw = () => {
    const { fg, bg } = themeColors();
    render(ctx, doc, page, selection, {
      zoom, fg, bg, group, marquee,
      fontPx: doc.preferences.fontSize,
      fontName: doc.preferences.fontName,
      lineWidth: doc.preferences.lineWidth,
      showTable: doc.preferences.tableVis,
      dragLabel: drag && drag.kind === 'attrLabel' ? drag.target : undefined,
    });
    updateCounts();
  };
  // Push the current model back to the extension host, which writes it to the
  // TextDocument (making the tab dirty; Ctrl+S persists it to the .fzm file).
  const commit = () => vscode.postMessage({ type: 'edit', text: serializeFzm(doc) });

  // Page tabs (multi-page diagrams). doc.tabs[i] is the name of page i+1
  // (myPage is 1-indexed). Clicking a tab switches the visible page.
  const pageTabs = document.getElementById('page-tabs');
  const renderPageTabs = () => {
    if (!pageTabs) return;
    pageTabs.innerHTML = '';
    if (doc.tabs.length === 0) doc.tabs.push('Page 1');
    doc.tabs.forEach((name, i) => {
      const tab = document.createElement('button');
      tab.textContent = name || `Page ${i + 1}`;
      tab.className = i + 1 === page ? 'page-tab active' : 'page-tab';
      tab.title = 'Click to switch · double-click to rename';
      tab.addEventListener('click', () => {
        page = i + 1;
        selection = null;
        group = [];
        marquee = null;
        drag = null;
        resize();
        redraw();
        renderPageTabs();
      });
      const del = document.createElement('span');
      del.textContent = ' ×';
      del.title = 'Delete this page';
      del.style.cursor = 'pointer';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation(); // don't also switch to the page
        if (doc.tabs.length <= 1) { void showMessage('Cannot delete the last page.'); return; }
        const pnum = i + 1;
        void showConfirm('Everything on this page will be permanently deleted. Delete page?').then((ok) => {
          if (!ok) return;
          deletePage(doc, pnum);
          if (page > doc.tabs.length) page = doc.tabs.length;
          selection = null;
          group = [];
          resize();
          redraw();
          renderPageTabs();
          commit();
        });
      });
      tab.appendChild(del);
      tab.addEventListener('dblclick', () => {
        void promptText('Page name:', doc.tabs[i]).then((name2) => {
          if (name2 === null) return;
          const trimmed = name2.trim();
          // Page names must be unique and non-empty (Fizzim's renameTab guard).
          if (!trimmed) return void showMessage('Page name cannot be empty.');
          if (doc.tabs.some((t, ti) => ti !== i && t === trimmed)) {
            return void showMessage('Page must have a unique name.');
          }
          doc.tabs[i] = trimmed;
          renderPageTabs();
          commit();
        });
      });
      pageTabs.appendChild(tab);
    });
    // "+" adds a new page and switches to it.
    const add = document.createElement('button');
    add.textContent = '+';
    add.className = 'page-tab';
    add.title = 'Add page';
    add.addEventListener('click', () => {
      doc.tabs.push(`Page ${doc.tabs.length + 1}`);
      page = doc.tabs.length;
      selection = null;
      resize();
      redraw();
      renderPageTabs();
      commit();
    });
    pageTabs.appendChild(add);
  };

  resize();
  redraw();
  renderPageTabs();

  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  canvas.focus();

  // Mouse position in model coordinates (undo the zoom scaling).
  const toCanvasCoords = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const applyZoom = (next: number) => {
    zoom = Math.min(4, Math.max(0.1, next));
    resize();
    redraw();
  };
  const fitToView = () => {
    const wrap = canvas.parentElement;
    const { width, height } = computeBounds(doc, page);
    if (!wrap || width === 0 || height === 0) return;
    const zx = (wrap.clientWidth - 4) / width;
    const zy = (wrap.clientHeight - 4) / height;
    applyZoom(Math.min(zx, zy));
  };

  // Redraw when the VS Code theme changes (it swaps the body class / CSS vars).
  const themeObserver = new MutationObserver(() => redraw());
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = toCanvasCoords(e);
    dragMoved = false;
    const tol = 6 / zoom; // ~6px on screen regardless of zoom

    // Attribute labels (state name, outputs, equation, priority, …) are grabbed
    // before shapes/handles, matching Java — clicking the text moves just that
    // label via its own x2Obj/y2Obj offset. Drag the shape by any non-text part.
    const labelHit = hitAttrLabel(ctx, doc, page, x, y);
    if (labelHit) {
      const obj = labelHit.kind === 'state' ? doc.states[labelHit.index] : doc.transitions[labelHit.index];
      const a = obj.attributes[labelHit.attrIndex];
      drag = { kind: 'attrLabel', target: labelHit, startMouseX: x, startMouseY: y, origX2: a.x2Obj, origY2: a.y2Obj };
      selection = null;
      group = [];
      redraw();
      return;
    }

    // If something is already selected, its drawn handles take priority so you
    // can grab a corner (resize) or a curve handle (reshape).
    if (selection?.kind === 'state') {
      const h = stateHandleAt(doc.states[selection.index], x, y, tol);
      if (h) {
        const s = doc.states[selection.index];
        drag = { kind: 'resize', index: selection.index, handle: h, startMouseX: x, startMouseY: y, origX0: s.x0, origY0: s.y0, origX1: s.x1, origY1: s.y1 };
        redraw();
        return;
      }
    } else if (selection?.kind === 'transition') {
      const sel = doc.transitions[selection.index];
      // A cross-page transition only exposes the four handles on this page.
      const crossSide = sel.kind === 'transition' && !transitionOnPage(doc, sel, page) ? crossPageSide(doc, sel, page) : null;
      const h = transitionHandleAt(sel, x, y, tol, crossSide);
      if (h) {
        drag = { kind: 'curve', index: selection.index, handle: h };
        redraw();
        return;
      }
    }

    const hit = hitTest(ctx, doc, page, x, y);

    // Ctrl/Cmd-click toggles a state/text in the multi-selection.
    if ((e.ctrlKey || e.metaKey) && hit && hit.kind !== 'transition') {
      selection = null;
      if (inGroup(hit)) group = group.filter((g) => selKey(g) !== selKey(hit));
      else group = [...group, hit];
      redraw();
      return;
    }

    // Clicking a member of an existing multi-selection drags the whole group.
    if (hit && group.length > 1 && inGroup(hit)) {
      const orig = group.map((sel) => {
        if (sel.kind === 'state') {
          const s = doc.states[sel.index];
          return { sel, ox: s.x0, oy: s.y0, ow: s.x1 - s.x0, oh: s.y1 - s.y0 };
        }
        const t = doc.texts[sel.index];
        return { sel, ox: t.x, oy: t.y, ow: 0, oh: 0 };
      });
      drag = { kind: 'group', startMouseX: x, startMouseY: y, orig };
      redraw();
      return;
    }

    group = [];
    selection = hit;
    if (selection && selection.kind === 'state') {
      const s = doc.states[selection.index];
      drag = { kind: 'state', index: selection.index, startMouseX: x, startMouseY: y, origX0: s.x0, origY0: s.y0, origX1: s.x1, origY1: s.y1 };
    } else if (selection && selection.kind === 'text') {
      const t = doc.texts[selection.index];
      drag = { kind: 'text', index: selection.index, startMouseX: x, startMouseY: y, origX: t.x, origY: t.y };
    } else if (!selection) {
      // Empty space: start a rubber-band box.
      drag = { kind: 'marquee', startMouseX: x, startMouseY: y };
      marquee = { x0: x, y0: y, x1: x, y1: y };
    }
    redraw();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const { x, y } = toCanvasCoords(e);
    if (drag.kind === 'state') {
      const dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      const s = doc.states[drag.index];
      const w = drag.origX1 - drag.origX0, h = drag.origY1 - drag.origY0;
      if (doc.preferences.grid) {
        s.x0 = snap(drag.origX0 + dx, doc.preferences.gridSize);
        s.y0 = snap(drag.origY0 + dy, doc.preferences.gridSize);
      } else {
        s.x0 = drag.origX0 + dx;
        s.y0 = drag.origY0 + dy;
      }
      s.x1 = s.x0 + w;
      s.y1 = s.y0 + h;
      updateAttachedTransitions(doc, s.name);
    } else if (drag.kind === 'resize') {
      const dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      const s = doc.states[drag.index];
      const h = drag.handle;
      if (h === 'tl' || h === 'bl') s.x0 = drag.origX0 + dx;
      if (h === 'tr' || h === 'br') s.x1 = drag.origX1 + dx;
      if (h === 'tl' || h === 'tr') s.y0 = drag.origY0 + dy;
      if (h === 'bl' || h === 'br') s.y1 = drag.origY1 + dy;
      if (s.x1 <= s.x0) s.x1 = s.x0 + 5;
      if (s.y1 <= s.y0) s.y1 = s.y0 + 5;
      updateAttachedTransitions(doc, s.name);
    } else if (drag.kind === 'curve') {
      dragMoved = true;
      applyCurveHandle(doc, doc.transitions[drag.index], drag.handle, x, y);
    } else if (drag.kind === 'attrLabel') {
      const dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      const obj = drag.target.kind === 'state' ? doc.states[drag.target.index] : doc.transitions[drag.target.index];
      const a = obj.attributes[drag.target.attrIndex];
      a.x2Obj = drag.origX2 + dx;
      a.y2Obj = drag.origY2 + dy;
    } else if (drag.kind === 'marquee') {
      dragMoved = true;
      if (marquee) {
        marquee.x1 = x;
        marquee.y1 = y;
      }
    } else if (drag.kind === 'group') {
      const dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      for (const o of drag.orig) {
        if (o.sel.kind === 'state') {
          const s = doc.states[o.sel.index];
          s.x0 = o.ox + dx;
          s.y0 = o.oy + dy;
          s.x1 = s.x0 + o.ow;
          s.y1 = s.y0 + o.oh;
          updateAttachedTransitions(doc, s.name);
        } else if (o.sel.kind === 'text') {
          const t = doc.texts[o.sel.index];
          t.x = o.ox + dx;
          t.y = o.oy + dy;
        }
      }
    } else {
      const dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      const t = doc.texts[drag.index];
      t.x = drag.origX + dx;
      t.y = drag.origY + dy;
    }
    redraw();
  });

  window.addEventListener('mouseup', () => {
    if (drag && drag.kind === 'marquee') {
      if (marquee && dragMoved) {
        group = objectsInBox(doc, page, normRect(marquee.x0, marquee.y0, marquee.x1, marquee.y1));
      } else {
        group = []; // a plain click on empty canvas clears the multi-selection
      }
      marquee = null;
      drag = null;
      redraw();
      return;
    }
    if (drag && dragMoved) commit(); // commit-on-release, like the Java app
    drag = null;
  });

  const deleteFromMenu = (sel: Selection) => {
    deleteSelection(doc, sel);
    selection = null;
    redraw();
    commit();
  };

  // Deletes the current selection or multi-selection (shared by the Delete key
  // and the Edit → Delete menu item).
  const deleteSelected = () => {
    if (group.length > 0) {
      const names = new Set(group.filter((g) => g.kind === 'state').map((g) => doc.states[g.index].name));
      const textIdx = group.filter((g) => g.kind === 'text').map((g) => g.index).sort((a, b) => b - a);
      doc.states = doc.states.filter((s) => !names.has(s.name));
      doc.transitions = doc.transitions.filter((t) =>
        t.kind === 'loopback' ? !names.has(t.state) : !names.has(t.startState) && !names.has(t.endState)
      );
      for (const i of textIdx) if (!doc.texts[i]?.isGlobalTable) doc.texts.splice(i, 1);
      group = [];
      selection = null;
      redraw();
      commit();
    } else if (selection) {
      deleteSelection(doc, selection);
      selection = null;
      redraw();
      commit();
    }
  };

  // Opens Fizzim's StateProperties dialog for a state (shared by double-click and
  // the "New State" menu item, which creates then immediately customizes it).
  const openStateDialog = (index: number) => {
    const s = doc.states[index];
    const extras: Field[] = [
      { kind: 'text', key: 'width', label: 'Width', value: String(s.x1 - s.x0) },
      { kind: 'text', key: 'height', label: 'Height', value: String(s.y1 - s.y0) },
      { kind: 'checkbox', key: 'reset', label: 'Reset state', value: s.reset },
      { kind: 'color', key: 'color', label: 'State color', value: colorIntToHex(s.color) },
    ];
    // The name is the Value of the "name" attribute row (Fizzim edits it there).
    const nameIdx = s.attributes.findIndex((a) => a.name === 'name');
    void showAttributeDialog('Edit State Properties', s.attributes, extras).then((res) => {
      if (!res) return;
      if (nameIdx >= 0) {
        const r = renameState(doc, index, res.rows[nameIdx].value);
        if (!r.ok) return void showMessage(r.error!);
      }
      applyAttributeEdits(s.attributes, res.rows, doc.stateAttrs);
      // Per-object attribute add/delete (Fizzim SPNew/SPDelete).
      for (const name of res.removedNames) {
        const i = s.attributes.findIndex((a) => a.name === name);
        if (i >= 0) s.attributes.splice(i, 1);
      }
      for (const na of res.added) { na.page = s.page; s.attributes.push(na); }
      sanitizeLocalOutputTypes(s.attributes, doc.outputs);
      setResetState(doc, index, Boolean(res.extras.reset));
      const w = Number(res.extras.width), h = Number(res.extras.height);
      if (Number.isFinite(w) && Number.isFinite(h)) resizeState(doc, index, w, h);
      s.color = hexToColorInt(String(res.extras.color));
      redraw();
      commit();
    });
  };

  // Opens the state-transition / loopback property dialog (Fizzim's
  // TransProperties). Shared by double-click and the right-click "Edit …
  // Properties" items and the create flows.
  const openTransitionDialog = (index: number) => {
    const t = doc.transitions[index];
    const isLoop = t.kind === 'loopback';
    // Object-level controls, matching Fizzim's TransProperties: start/end
    // state dropdowns and a Stub? checkbox (normal transitions only), + color.
    const extras: Field[] = [];
    const names = doc.states.map((s) => s.name);
    if (!isLoop) {
      extras.push({ kind: 'select', key: 'start', label: 'Start State', value: t.startState, options: names });
      extras.push({ kind: 'select', key: 'end', label: 'End State', value: t.endState, options: names });
      extras.push({ kind: 'checkbox', key: 'stub', label: 'Stub?', value: t.stub });
    } else {
      // Loopback: a single State dropdown to re-attach it (Fizzim's loopback
      // TransProperties shows "State:" instead of Start/End).
      extras.push({ kind: 'select', key: 'state', label: 'State', value: (t as { state: string }).state, options: names });
    }
    extras.push({ kind: 'color', key: 'color', label: 'Transition color', value: colorIntToHex(t.color) });
    // Show every declared output as a table row so any Mealy output can be set.
    const rowAttrs = transitionDialogAttributes(t, doc.outputs);
    const nameIdx = rowAttrs.findIndex((a) => a.name === 'name');
    const title = isLoop ? 'Edit Loopback Transition Properties' : 'Edit State Transition Properties';
    void showAttributeDialog(title, rowAttrs, extras).then((res) => {
      if (!res) return;
      if (nameIdx >= 0) {
        const rn = renameTransition(doc, index, res.rows[nameIdx].value);
        if (!rn.ok) return void showMessage(rn.error!);
      }
      if (!isLoop) {
        const rc = reconnectTransition(doc, index, String(res.extras.start), String(res.extras.end));
        if (!rc.ok) return void showMessage(rc.error!);
        setTransitionStub(doc, t, Boolean(res.extras.stub));
      } else {
        const rl = reconnectLoopback(doc, index, String(res.extras.state));
        if (!rl.ok) return void showMessage(rl.error!);
      }
      applyAttributeEdits(rowAttrs, res.rows, doc.transAttrs);
      reconcileTransitionOutputs(t, rowAttrs);
      // Per-object attribute add/delete (Fizzim TPNew/TPDelete).
      for (const name of res.removedNames) {
        const i = t.attributes.findIndex((a) => a.name === name);
        if (i >= 0) t.attributes.splice(i, 1);
      }
      for (const na of res.added) { na.page = t.page; t.attributes.push(na); }
      sanitizeLocalOutputTypes(t.attributes, doc.outputs);
      t.color = hexToColorInt(String(res.extras.color));
      redraw();
      commit();
    });
  };

  const openTextDialog = (index: number) => {
    const txt = doc.texts[index];
    if (txt.isGlobalTable) return;
    void showForm('Edit Text', [{ kind: 'text', key: 'text', label: 'Text', value: txt.text ?? '' }]).then((res) => {
      if (!res) return;
      txt.text = String(res.text);
      redraw();
      commit();
    });
  };

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = toCanvasCoords(e);
    const items: { label: string; action: () => void }[] = [];

    // Right-clicking a cross-page transition's label offers to move that label
    // to the transition's other endpoint page (Fizzim's TXT-select "Move to
    // Page", restricted to the two endpoint pages). Checked before shape hits,
    // like Java (attribute text takes priority).
    const labelHit = hitAttrLabel(ctx, doc, page, x, y);
    if (labelHit && labelHit.kind === 'transition') {
      const t = doc.transitions[labelHit.index];
      if (t.kind === 'transition') {
        const sp = doc.states.find((s) => s.name === t.startState)?.page;
        const ep = doc.states.find((s) => s.name === t.endState)?.page;
        if (sp !== undefined && ep !== undefined && sp !== ep) {
          const a = t.attributes[labelHit.attrIndex];
          for (const target of [sp, ep]) {
            if (target === a.page) continue;
            const tabName = doc.tabs[target - 1] || `Page ${target}`;
            items.push({
              label: `Move label to ${tabName}`,
              action: () => { a.page = target; redraw(); commit(); },
            });
          }
          if (items.length > 0) {
            showContextMenu(e.clientX, e.clientY, items);
            return;
          }
        }
      }
    }

    const hit = hitTest(ctx, doc, page, x, y);

    if (!hit) {
      // With a multi-selection active, Java offers "Move to Page" for the whole
      // group instead of the New-object menu.
      if (group.length > 0) {
        doc.tabs.forEach((tabName, ti) => {
          const targetPage = ti + 1;
          if (targetPage === page) return;
          items.push({
            label: `Move to ${tabName || `Page ${targetPage}`}`,
            action: () => {
              const movers = group.filter((g) => g.kind === 'state' || g.kind === 'text');
              for (const m of movers) {
                if (m.kind === 'state') moveStateToPage(doc, m.index, targetPage);
                else if (m.kind === 'text') moveTextToPage(doc, m.index, targetPage);
              }
              selection = null;
              group = [];
              redraw();
              commit();
            },
          });
        });
      } else {
      const newState = () =>
        createState(doc, x, y, page, defaults.stateColor, doc.preferences.stateW || undefined, doc.preferences.stateH || undefined);
      // "New State" drops the state then opens its properties to customize it;
      // "Quick New State" just drops it with defaults (Fizzim's two menu items).
      items.push({
        label: 'New State',
        action: () => {
          const s = newState();
          resize();
          redraw();
          commit();
          openStateDialog(doc.states.indexOf(s));
        },
      });
      items.push({
        label: 'Quick New State',
        action: () => {
          newState();
          resize();
          redraw();
          commit();
        },
      });
      // New State Transition / New Loopback Transition (Fizzim's empty-canvas
      // items): create between the last two states / on the last state, then
      // open the property dialog to pick endpoints. Guarded by state count.
      items.push({
        label: 'New State Transition',
        action: () => {
          if (doc.states.length < 2) {
            void showMessage('Must be more than 2 states before a transition can be created');
            return;
          }
          const a = doc.states[doc.states.length - 2];
          const b = doc.states[doc.states.length - 1];
          const t = createTransition(doc, a, b, page, defaults.transitionColor);
          resize();
          redraw();
          commit();
          openTransitionDialog(doc.transitions.indexOf(t));
        },
      });
      items.push({
        label: 'New Loopback Transition',
        action: () => {
          if (doc.states.length < 1) {
            void showMessage('Must be more than 1 states before a loopback transition can be created');
            return;
          }
          const st = doc.states[doc.states.length - 1];
          const lp = createLoopback(doc, st, x, y, page, defaults.loopbackColor);
          resize();
          redraw();
          commit();
          openTransitionDialog(doc.transitions.indexOf(lp));
        },
      });
      items.push({
        label: 'New Free Text',
        action: () => {
          void promptText('Enter text:').then((text) => {
            if (text) {
              createText(doc, x, y, page, text);
              redraw();
              commit();
            }
          });
        },
      });
      }
    } else if (hit.kind === 'state') {
      const state = doc.states[hit.index];
      items.push({ label: 'Edit State Properties', action: () => openStateDialog(hit.index) });
      items.push({
        label: 'Add Loopback Transition',
        action: () => {
          const lp = createLoopback(doc, state, x, y, page, defaults.loopbackColor);
          redraw();
          commit();
          openTransitionDialog(doc.transitions.indexOf(lp));
        },
      });
      for (const other of doc.states) {
        if (other === state) continue;
        items.push({
          label: `Add State Transition to ${other.name}`,
          action: () => {
            const t = createTransition(doc, state, other, page, defaults.transitionColor);
            redraw();
            commit();
            openTransitionDialog(doc.transitions.indexOf(t));
          },
        });
      }
      // Move to another page (also moves the rest of the group if multi-selected).
      doc.tabs.forEach((tabName, ti) => {
        const targetPage = ti + 1;
        if (targetPage === page) return;
        items.push({
          label: `Move to ${tabName || `Page ${targetPage}`}`,
          action: () => {
            // A multi-select group moves states and free text together (Java
            // moves object types 0 and 3); a lone state moves by itself.
            const movers = group.length > 0 && inGroup(hit) ? group.filter((g) => g.kind === 'state' || g.kind === 'text') : [hit];
            for (const m of movers) {
              if (m.kind === 'state') moveStateToPage(doc, m.index, targetPage);
              else if (m.kind === 'text') moveTextToPage(doc, m.index, targetPage);
            }
            selection = null;
            group = [];
            redraw();
            commit();
          },
        });
      });
      items.push({
        label: 'Duplicate State',
        action: () => {
          duplicateState(doc, hit.index);
          resize();
          redraw();
          commit();
        },
      });
      items.push({ label: 'Delete State', action: () => deleteFromMenu(hit) });
    } else if (hit.kind === 'transition') {
      const isLoop = doc.transitions[hit.index].kind === 'loopback';
      items.push({
        label: isLoop ? 'Edit Loopback Transition Properties' : 'Edit State Transition Properties',
        action: () => openTransitionDialog(hit.index),
      });
      items.push({ label: isLoop ? 'Delete Loopback' : 'Delete Transition', action: () => deleteFromMenu(hit) });
    } else if (hit.kind === 'text' && !doc.texts[hit.index].isGlobalTable) {
      items.push({ label: 'Edit Text', action: () => openTextDialog(hit.index) });
      // Move a free-text object to another page (whole group if multi-selected).
      doc.tabs.forEach((tabName, ti) => {
        const targetPage = ti + 1;
        if (targetPage === page) return;
        items.push({
          label: `Move to ${tabName || `Page ${targetPage}`}`,
          action: () => {
            const movers = group.length > 0 && inGroup(hit) ? group.filter((g) => g.kind === 'state' || g.kind === 'text') : [hit];
            for (const m of movers) {
              if (m.kind === 'state') moveStateToPage(doc, m.index, targetPage);
              else if (m.kind === 'text') moveTextToPage(doc, m.index, targetPage);
            }
            selection = null;
            group = [];
            redraw();
            commit();
          },
        });
      });
      items.push({ label: 'Delete Text', action: () => deleteFromMenu(hit) });
    }

    if (items.length > 0) showContextMenu(e.clientX, e.clientY, items);
  });

  window.addEventListener('keydown', (e) => {
    // Don't hijack keys while typing in a dialog field.
    const el = e.target as HTMLElement | null;
    const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

    // Arrow keys nudge the selected state (a convenience; not in original Fizzim).
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    if (!inField && selection?.kind === 'state' && nudge[e.key]) {
      e.preventDefault();
      const step = e.shiftKey ? doc.preferences.gridSize : 1;
      const [ux, uy] = nudge[e.key];
      const s = doc.states[selection.index];
      s.x0 += ux * step; s.y0 += uy * step; s.x1 += ux * step; s.y1 += uy * step;
      updateAttachedTransitions(doc, s.name);
      redraw();
      commit();
      return;
    }

    // Escape clears the current selection / multi-selection.
    if (e.key === 'Escape' && !inField) {
      selection = null;
      group = [];
      marquee = null;
      redraw();
      return;
    }

    // Forward undo/redo to the extension host: when the webview has focus, the
    // keystroke wouldn't otherwise reach VS Code's text-document undo stack.
    if (!inField && (e.ctrlKey || e.metaKey)) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        vscode.postMessage({ type: 'undo' });
        return;
      }
      if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        vscode.postMessage({ type: 'redo' });
        return;
      }
      if (k === 'a') {
        // Select all states + free text on the current page.
        e.preventDefault();
        selection = null;
        group = objectsInBox(doc, page, { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 });
        redraw();
        return;
      }
    }

    if (e.key === 'Delete' && !inField) {
      deleteSelected();
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = toCanvasCoords(e);
    const hit = hitTest(ctx, doc, page, x, y);
    if (!hit) return;

    if (hit.kind === 'state') openStateDialog(hit.index);
    else if (hit.kind === 'transition') openTransitionDialog(hit.index);
    else if (hit.kind === 'text') openTextDialog(hit.index);
  });

  // File → Generate HDL ▸ <language> (submenu items carry a data-lang).
  document.querySelectorAll<HTMLElement>('[data-lang]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({
        type: 'generate',
        text: serializeFzm(doc),
        language: el.dataset.lang,
        customArgs: doc.preferences.customArgs,
      });
    });
  });

  // Export the current page as an image. Java exports into a fresh image that is
  // always light and always 1:1 (FizzimGui.exportFile), so render offscreen
  // rather than snapshotting the live canvas — otherwise the current zoom and
  // dark mode get baked in. Selection/marquee are excluded too.
  const exportImage = (mime: 'image/png' | 'image/jpeg') => {
    const { width, height } = computeBounds(doc, page);
    const off = document.createElement('canvas');
    off.width = Math.round(width);
    off.height = Math.round(height);
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, off.width, off.height);
    render(offCtx, doc, page, null, {
      zoom: 1,
      fg: '#000000',
      bg: '#ffffff',
      group: [],
      marquee: null,
      fontPx: doc.preferences.fontSize,
      fontName: doc.preferences.fontName,
      lineWidth: doc.preferences.lineWidth,
      showTable: doc.preferences.tableVis,
    });
    const dataUrl = mime === 'image/jpeg' ? off.toDataURL('image/jpeg', 0.92) : off.toDataURL('image/png');
    vscode.postMessage({ type: 'exportImage', dataUrl });
  };
  document.getElementById('export-png-btn')?.addEventListener('click', () => exportImage('image/png'));
  document.getElementById('export-jpg-btn')?.addEventListener('click', () => exportImage('image/jpeg'));

  const prefsBtn = document.getElementById('prefs-btn');
  if (prefsBtn) {
    prefsBtn.addEventListener('click', () => {
      const p = doc.preferences;
      void showForm('Preferences', [
        { kind: 'select', key: 'fontName', label: 'Font', value: p.fontName, options: fontOptions(p.fontName) },
        { kind: 'text', key: 'fontSize', label: 'Font size', value: String(p.fontSize) },
        { kind: 'text', key: 'lineWidth', label: 'Line width', value: String(p.lineWidth) },
        { kind: 'text', key: 'gridSize', label: 'Grid size', value: String(p.gridSize) },
        { kind: 'text', key: 'stateW', label: 'Default state width', value: String(p.stateW) },
        { kind: 'text', key: 'stateH', label: 'Default state height', value: String(p.stateH) },
        { kind: 'checkbox', key: 'tableVis', label: 'Show global table', value: p.tableVis },
        { kind: 'text', key: 'tableSpace', label: 'Table row spacing', value: String(p.tableSpace) },
        { kind: 'select', key: 'tableFontName', label: 'Table font', value: p.tableFontName, options: fontOptions(p.tableFontName) },
        { kind: 'text', key: 'tableFontSize', label: 'Table font size', value: String(p.tableFontSize) },
        { kind: 'color', key: 'tableColor', label: 'Table color', value: colorIntToHex(p.tableColor) },
        { kind: 'color', key: 'defStateColor', label: 'Default state color', value: colorIntToHex(defaults.stateColor) },
        { kind: 'color', key: 'defTransColor', label: 'Default transition color', value: colorIntToHex(defaults.transitionColor) },
        { kind: 'color', key: 'defLoopColor', label: 'Default loopback color', value: colorIntToHex(defaults.loopbackColor) },
        { kind: 'text', key: 'customArgs', label: 'Custom fizzim.pl args (e.g. -encoding onehot)', value: p.customArgs },
      ]).then((res) => {
        if (!res) return;
        // Empty/invalid/non-positive input keeps the previous value: Number('')
        // is 0, and a font size or line width of 0 would render invisibly.
        const num = (v: unknown, fallback: number) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : fallback;
        };
        p.fontName = String(res.fontName).trim() || p.fontName;
        p.fontSize = num(res.fontSize, p.fontSize);
        p.lineWidth = num(res.lineWidth, p.lineWidth);
        p.gridSize = num(res.gridSize, p.gridSize);
        p.stateW = num(res.stateW, p.stateW);
        p.stateH = num(res.stateH, p.stateH);
        p.tableVis = Boolean(res.tableVis);
        p.tableSpace = num(res.tableSpace, p.tableSpace);
        p.tableFontName = String(res.tableFontName).trim() || p.tableFontName;
        p.tableFontSize = num(res.tableFontSize, p.tableFontSize);
        p.tableColor = hexToColorInt(String(res.tableColor));
        p.customArgs = String(res.customArgs).trim();
        // Default new-object colors: app-level (not in the .fzm), so persist them
        // to the fizzim.default* settings via the host rather than committing.
        defaults.stateColor = hexToColorInt(String(res.defStateColor));
        defaults.transitionColor = hexToColorInt(String(res.defTransColor));
        defaults.loopbackColor = hexToColorInt(String(res.defLoopColor));
        vscode.postMessage({
          type: 'setDefaultColors',
          stateColor: String(res.defStateColor),
          transitionColor: String(res.defTransColor),
          loopbackColor: String(res.defLoopColor),
        });
        // keep the toolbar checkboxes in sync with the new values
        if (typeof gridToggle !== 'undefined' && gridToggle) gridToggle.checked = p.grid;
        if (typeof tableToggle !== 'undefined' && tableToggle) tableToggle.checked = p.tableVis;
        resize();
        redraw();
        commit();
      });
    });
  }

  // Global Attributes ▸ <tab>: open the tabbed editor on the chosen tab.
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      void showGlobalEditor(doc, Number(el.dataset.tab)).then((result) => {
        if (!result) return;
        doc = result;
        selection = null;
        resize();
        redraw();
        commit();
      });
    });
  });

  // File → Page Setup: set the canvas pixel dimensions (Fizzim's Page Setup),
  // stored in the .fzm preferences. Replaces the old inline W×H toolbar inputs;
  // syncPageInputs is now a no-op kept so existing callers don't need changing.
  const syncPageInputs = () => {};
  document.getElementById('menu-pagesetup')?.addEventListener('click', () => {
    const p = doc.preferences;
    void showForm('Page Setup', [
      { kind: 'text', key: 'w', label: 'Page width (px)', value: String(p.pageSizeW) },
      { kind: 'text', key: 'h', label: 'Page height (px)', value: String(p.pageSizeH) },
    ]).then((res) => {
      if (!res) return;
      const w = Number(res.w), h = Number(res.h);
      if (Number.isFinite(w) && w >= 100) p.pageSizeW = Math.round(w);
      if (Number.isFinite(h) && h >= 100) p.pageSizeH = Math.round(h);
      resize();
      redraw();
      commit();
    });
  });

  // --- Menu-bar behaviour: click a title to open its dropdown; while a menu is
  // open, hovering another title switches to it; any leaf click or an outside
  // click closes everything (submenus open on hover, via CSS).
  const menus = Array.from(document.querySelectorAll<HTMLElement>('#menubar .menu'));
  const closeMenus = () => menus.forEach((m) => m.classList.remove('open'));
  menus.forEach((m) => {
    const title = m.querySelector('.menu-title');
    title?.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains('open');
      closeMenus();
      if (!wasOpen) m.classList.add('open');
    });
    title?.addEventListener('mouseenter', () => {
      if (menus.some((x) => x.classList.contains('open'))) {
        closeMenus();
        m.classList.add('open');
      }
    });
  });
  // Clicking a submenu parent keeps the menu open (its flyout is hover-driven).
  document.querySelectorAll<HTMLElement>('#menubar .menu-item.has-sub').forEach((it) => {
    it.addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => closeMenus());

  // File/Edit/Help items that map to VS Code commands or existing handlers.
  const cmd = (id: string, command: string) =>
    document.getElementById(id)?.addEventListener('click', () => vscode.postMessage({ type: 'command', command }));
  cmd('menu-new', 'fizzim.newDiagram');
  cmd('menu-open', 'workbench.action.files.openFile');
  cmd('menu-save', 'workbench.action.files.save');
  cmd('menu-saveas', 'workbench.action.files.saveAs');
  document.getElementById('menu-viewtext')?.addEventListener('click', () => vscode.postMessage({ type: 'viewAsText' }));
  document.getElementById('menu-undo')?.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  document.getElementById('menu-redo')?.addEventListener('click', () => vscode.postMessage({ type: 'redo' }));
  document.getElementById('menu-delete')?.addEventListener('click', () => deleteSelected());
  document.getElementById('menu-about')?.addEventListener('click', () => {
    void showMessage(
      'Fizzim for VS Code — a community port of Fizzim (Zimmer Design Services). ' +
        'Draw finite-state machines and generate synthesizable Verilog/VHDL. GPL-3.0-or-later.'
    );
  });

  // Zoom controls (help with large FSMs that don't fit the viewport).
  document.getElementById('zoom-in-btn')?.addEventListener('click', () => applyZoom(zoom * 1.25));
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => applyZoom(zoom / 1.25));
  document.getElementById('zoom-reset-btn')?.addEventListener('click', () => applyZoom(1));
  document.getElementById('zoom-fit-btn')?.addEventListener('click', () => fitToView());
  document.getElementById('fit-page-btn')?.addEventListener('click', () => {
    // Measure content alone (floorToPage=false): flooring at the current page
    // size would make each click grow the page by the bounds margin.
    const b = computeBounds(doc, page, false);
    doc.preferences.pageSizeW = Math.max(100, Math.round(b.width));
    doc.preferences.pageSizeH = Math.max(100, Math.round(b.height));
    syncPageInputs();
    resize();
    redraw();
    commit();
  });

  // Grid toggle (persists to the .fzm <Grid> preference).
  const tableToggle = document.getElementById('table-toggle') as HTMLInputElement | null;
  if (tableToggle) {
    tableToggle.checked = doc.preferences.tableVis;
    tableToggle.addEventListener('change', () => {
      doc.preferences.tableVis = tableToggle.checked;
      redraw();
      commit();
    });
  }
  const gridToggle = document.getElementById('grid-toggle') as HTMLInputElement | null;
  if (gridToggle) {
    gridToggle.checked = doc.preferences.grid;
    gridToggle.addEventListener('change', () => {
      doc.preferences.grid = gridToggle.checked;
      redraw();
      commit();
    });
  }
  // Dark mode toggle: a view preference (not stored in the .fzm) persisted to the
  // fizzim.darkMode setting via the host, so it isn't a document edit.
  const darkToggle = document.getElementById('dark-toggle') as HTMLInputElement | null;
  if (darkToggle) {
    darkToggle.checked = darkMode;
    darkToggle.addEventListener('change', () => {
      darkMode = darkToggle.checked;
      redraw();
      vscode.postMessage({ type: 'setDarkMode', value: darkMode });
    });
  }

  // Ctrl/Cmd + mouse wheel zooms, like most diagram editors.
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? zoom * 1.1 : zoom / 1.1);
    },
    { passive: false }
  );

  // External edits (e.g. the file changed on disk, or an undo): re-parse and
  // redraw. Selection/drag state is dropped, which is fine for an outside edit.
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'externalUpdate' && typeof msg.text === 'string') {
      doc = parseFzm(msg.text);
      if (page > doc.tabs.length) page = 1;
      selection = null;
      group = [];
      marquee = null;
      drag = null;
      syncPageInputs();
      if (gridToggle) gridToggle.checked = doc.preferences.grid;
      if (tableToggle) tableToggle.checked = doc.preferences.tableVis;
      resize();
      redraw();
      renderPageTabs();
    }
  });
}

main();
