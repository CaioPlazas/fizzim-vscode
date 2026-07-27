import { defaultDocument } from '../fzm/model';
import type { FzmDocument } from '../fzm/model';
import { parseFzm } from '../fzm/parser';
import { serializeFzm } from '../fzm/serializer';
import { attrIsVisible, AttrLabelTarget, computeBounds, hitAttrLabel, render, transitionOnPage } from './render';
import { connectAnchorAt, crossPageSide, CurveHandle, hitTest, normRect, objectsInBox, Selection, StateHandle, stateHandleAt, transitionHandleAt } from './hitTest';
import { moveTransition, nearestBorderPoint, recomputeCrossPage, recomputeLoopback, recomputeStub } from './geometry';
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
import { readTheme, SurfaceMode } from './theme';
import { buildEditBar } from './editBar';

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
  | { kind: 'connect'; fromIndex: number; to: { x: number; y: number }; target: number | null }
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
        else moveTransition(t, startState, endState);
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

// A real .fzm always has at least one page tab - the Java GUI can't produce a
// file without one, and defaultDocument() always seeds 'Page 1'. A hand-created
// blank file (e.g. New File in the VS Code explorer, named *.fzm) parses to
// empty machine/state/trans attribute lists too, since there's no header to
// read - and reconcileGlobals (globals.ts) treats every state/transition's own
// attributes as stale extras once the global lists are shorter than them,
// deleting them the first time Global Attributes is used (e.g. to add an
// output). Detect that "no tabs" signature and seed the same header
// defaultDocument() gives New Diagram, instead of trusting a parse that can
// never correspond to a real Fizzim file.
function parseOrDefault(text: string): FzmDocument {
  const parsed = parseFzm(text);
  return parsed.tabs.length === 0 ? defaultDocument() : parsed;
}

function main(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const initialText = window.__FZM_TEXT__;
  if (!canvas || initialText === undefined) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const vscode = acquireVsCodeApi();
  let page = 1;
  let doc = parseOrDefault(initialText);
  let selection: Selection | null = null;
  let hover: Selection | null = null; // what the cursor is over (view-only)
  let group: Selection[] = []; // multi-selection (states + text)
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let drag: DragState | null = null;
  let dragMoved = false;
  let nudgeCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let zoom = 1;
  // Panning the view by scrolling #canvas-wrap: space-drag or middle-drag.
  let spaceHeld = false;
  let pan: { startX: number; startY: number; scrollL: number; scrollT: number } | null = null;

  const selKey = (s: Selection) => `${s.kind}:${s.index}`;
  const selKeyOrNull = (s: Selection | null) => (s ? selKey(s) : '');
  const inGroup = (s: Selection) => group.some((g) => selKey(g) === selKey(s));

  // The canvas surface (see theme.ts): white "paper" by default, or the live VS
  // Code theme when the user opts in. A view preference, not a document one, so
  // it round-trips through the fizzim.canvasSurface setting via the host.
  let surface: SurfaceMode =
    (window as unknown as { __FZM_SURFACE__?: SurfaceMode }).__FZM_SURFACE__ === 'theme' ? 'theme' : 'paper';

  // readTheme() calls getComputedStyle(document.body), a forced style
  // recalculation - cheap once, but redraw() runs on every drag mousemove, so
  // doing it unconditionally there was a per-frame layout cost. Cache it and
  // only recompute when something that could change it actually happens: the
  // VS Code theme switching (themeObserver, below) or the surface toggle.
  let cachedTheme: ReturnType<typeof readTheme> | null = null;
  const currentTheme = () => (cachedTheme ??= readTheme(surface));
  const invalidateTheme = () => { cachedTheme = null; };

  // Default colors for newly created objects (Fizzim's Pref defaults). Kept
  // outside the .fzm (app-level, like Fizzim) — seeded from the fizzim.default*
  // settings and editable from the Preferences dialog (persisted via the host).
  const rawDefaults = (window as unknown as { __FZM_DEFAULTS__?: { stateColor?: string; transitionColor?: string; loopbackColor?: string } }).__FZM_DEFAULTS__ ?? {};
  const defaults = {
    stateColor: hexToColorInt(rawDefaults.stateColor ?? '#000000'),
    transitionColor: hexToColorInt(rawDefaults.transitionColor ?? '#000000'),
    loopbackColor: hexToColorInt(rawDefaults.loopbackColor ?? '#000000'),
  };

  // The canvas is laid out at the page resolution (content-expanded) times the
  // zoom factor, in CSS pixels, so it displays 1:1 and scrolls inside
  // #canvas-wrap instead of being squished to fit the viewport.
  //
  // The *buffer* is that size times the device pixel ratio: on a HiDPI or
  // fractionally-scaled display a CSS pixel is not a device pixel, and sizing
  // the buffer in CSS pixels (as this did until v2) meant the browser resampled
  // every stroke on the way to the screen - the single biggest reason the
  // diagram looked soft. render() scales its transform by zoom x dpr to match.
  // Mouse math is unaffected: getBoundingClientRect is CSS pixels either way.
  const dpr = () => window.devicePixelRatio || 1;
  const resize = () => {
    const { width, height } = computeBounds(doc, page);
    const w = Math.round(width * zoom);
    const h = Math.round(height * zoom);
    canvas.width = Math.round(w * dpr());
    canvas.height = Math.round(h * dpr());
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };
  // --- Status bar. v1 had nowhere to put this, so the counts were wedged into
  // the menu bar's right edge and the selection was never described at all.
  const countsEl = document.getElementById('status-counts');
  const selectionEl = document.getElementById('status-selection');
  const posEl = document.getElementById('status-pos');
  const zoomBtn = document.getElementById('zoom-btn');

  // What's selected, in the words the user thinks in ("state IDLE") rather than
  // the model's ("state index 3").
  const describeSelection = (): string => {
    if (group.length > 1) return `${group.length} objects selected`;
    if (!selection) return '';
    if (selection.kind === 'state') {
      const s = doc.states[selection.index];
      if (!s) return '';
      const outs = s.attributes.filter((a) => a.name !== 'name' && attrIsVisible(a)).length;
      return `state ${s.name}${s.reset ? ' · reset' : ''}${outs ? ` · ${outs} output${outs > 1 ? 's' : ''}` : ''}`;
    }
    if (selection.kind === 'transition') {
      const t = doc.transitions[selection.index];
      if (!t) return '';
      const eq = t.attributes.find((a) => a.name === 'equation')?.value;
      const label = t.kind === 'loopback' ? `loopback on ${t.state}` : `${t.startState} → ${t.endState}`;
      return eq ? `${label} · ${eq}` : label;
    }
    const txt = doc.texts[selection.index];
    return txt?.isGlobalTable ? 'global table' : 'text';
  };

  // A transient status-bar note (e.g. after a delete), shown only while nothing
  // is selected — the moment the user selects something, describeSelection wins.
  // The safety net for accidental deletes: it says what vanished and that Ctrl+Z
  // brings it back.
  let flashMsg = '';
  let flashTimer = 0;
  const flashStatus = (msg: string) => {
    flashMsg = msg;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { flashMsg = ''; updateCounts(); }, 5000);
    updateCounts();
  };

  const updateCounts = () => {
    const s = doc.states.filter((o) => o.page === page).length;
    const t = doc.transitions.filter((o) => o.page === page).length;
    const pageInfo = doc.tabs.length > 1 ? ` · page ${page}/${doc.tabs.length}` : '';
    if (countsEl) countsEl.textContent = `${s} states, ${t} transitions${pageInfo}`;
    if (selectionEl) selectionEl.textContent = describeSelection() || flashMsg;
    // The button shows the live zoom, including values no preset covers (Fit, or
    // a Ctrl+wheel landing on 137%). The chevron is markup, so only the number
    // is replaced.
    if (zoomBtn) zoomBtn.childNodes[0].textContent = `${Math.round(zoom * 100)}%`;
  };

  // Assigned once the edit bar is built (below). A no-op until then so redraw()
  // can call it unconditionally; it only rebuilds when the selection identity
  // changes, so calling it every redraw is cheap and never steals focus.
  let refreshEditBar = () => {};
  // Forces the edit bar to rebuild even when the selection hasn't changed -
  // for after a modal property dialog edits the very object it's showing
  // (rename, reconnect, etc.), so the bar's fields don't sit stale.
  let rebuildEditBar = () => {};

  const redraw = () => {
    render(ctx, doc, page, selection, {
      zoom, theme: currentTheme(), dpr: dpr(), group, marquee,
      // Hover visuals (fill lift, connect anchors) are suppressed during any
      // drag; a connect drag draws its own overlay instead.
      hover: drag ? null : hover,
      connect: drag && drag.kind === 'connect' ? { fromState: drag.fromIndex, to: drag.to, target: drag.target } : null,
      fontPx: doc.preferences.fontSize,
      fontName: doc.preferences.fontName,
      lineWidth: doc.preferences.lineWidth,
      showTable: doc.preferences.tableVis,
      dragLabel: drag && drag.kind === 'attrLabel' ? drag.target : undefined,
    });
    updateCounts();
    refreshEditBar();
  };
  // Coalesces redraws to once per animation frame. High-polling-rate mice can
  // fire mousemove well above 60Hz; without this each event would trigger a
  // full canvas re-render, most of which the screen never has a chance to show.
  let redrawScheduled = false;
  const scheduleRedraw = () => {
    if (redrawScheduled) return;
    redrawScheduled = true;
    requestAnimationFrame(() => {
      redrawScheduled = false;
      redraw();
    });
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
        hover = null; // whatever was under the cursor isn't on this page
        group = [];
        marquee = null;
        drag = null;
        resize();
        redraw();
        renderPageTabs();
      });
      const del = document.createElement('span');
      del.textContent = '×';
      del.className = 'tab-close';
      del.title = 'Delete this page';
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
    add.className = 'page-tab page-add';
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

  // Re-crisps the canvas when devicePixelRatio changes - e.g. the VS Code
  // window is dragged to a monitor with different display scaling. A
  // matchMedia query for the current ratio fires 'change' the moment it stops
  // matching (i.e. the ratio just changed); resolution match queries are a
  // point-in-time snapshot, so we re-subscribe at the new ratio each time.
  const watchDprChanges = () => {
    const mq = window.matchMedia(`(resolution: ${dpr()}dppx)`);
    mq.addEventListener(
      'change',
      () => {
        resize();
        redraw();
        watchDprChanges();
      },
      { once: true }
    );
  };
  watchDprChanges();

  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  canvas.focus();

  // Mouse position in model coordinates (undo the zoom scaling). Takes anything
  // with clientX/clientY, so it works for a MouseEvent or a bare point.
  const toCanvasCoords = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  // Zoom while keeping the model point under (clientX, clientY) fixed on screen.
  // The canvas scrolls inside #canvas-wrap, so after resizing the buffer we set
  // the wrap's scroll so that point lands back under the same pixel. Derivation:
  //   canvasLeft = wrapLeft - scrollLeft;  screenX = canvasLeft + mx*zoom
  //   want screenX == clientX  =>  scrollLeft = wrapLeft + mx*zoom - clientX
  const applyZoomAt = (next: number, clientX: number, clientY: number) => {
    const wrap = canvas.parentElement;
    const clamped = Math.min(4, Math.max(0.1, next));
    if (!wrap || clamped === zoom) return;
    const { x: mx, y: my } = toCanvasCoords({ clientX, clientY }); // pre-zoom model point
    zoom = clamped;
    resize();
    const wrapRect = wrap.getBoundingClientRect();
    wrap.scrollLeft = wrapRect.left + mx * zoom - clientX;
    wrap.scrollTop = wrapRect.top + my * zoom - clientY;
    redraw();
  };

  // Button / command zoom anchors on the viewport centre (there's no cursor).
  const applyZoom = (next: number) => {
    const wrap = canvas.parentElement;
    if (!wrap) { zoom = Math.min(4, Math.max(0.1, next)); resize(); redraw(); return; }
    const r = wrap.getBoundingClientRect();
    applyZoomAt(next, r.left + r.width / 2, r.top + r.height / 2);
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
  const themeObserver = new MutationObserver(() => { invalidateTheme(); redraw(); });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  const TOL = () => 6 / zoom; // ~6px on screen regardless of zoom

  // The handle of the *selected* object at (x, y), if any. Selected objects draw
  // handles on top of everything, so both mousedown (to start a drag) and
  // mousemove (to pick a cursor) have to agree on where they are — hence one
  // helper rather than two copies that can drift.
  const handleAt = (x: number, y: number): StateHandle | CurveHandle | null => {
    if (selection?.kind === 'state') return stateHandleAt(doc.states[selection.index], x, y, TOL());
    if (selection?.kind === 'transition') {
      const sel = doc.transitions[selection.index];
      // A cross-page transition only exposes the four handles on this page.
      const crossSide = sel.kind === 'transition' && !transitionOnPage(doc, sel, page) ? crossPageSide(doc, sel, page) : null;
      return transitionHandleAt(sel, x, y, TOL(), crossSide);
    }
    return null;
  };

  canvas.addEventListener('mousedown', (e) => {
    // Pan: middle-button drag, or left-drag with Space held. Grabs the view and
    // scrolls #canvas-wrap; never touches the model, so it can't select or move
    // anything. Checked before everything else.
    const wrap = canvas.parentElement;
    if (wrap && (e.button === 1 || (spaceHeld && e.button === 0))) {
      pan = { startX: e.clientX, startY: e.clientY, scrollL: wrap.scrollLeft, scrollT: wrap.scrollTop };
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return; // only the left button interacts with the model
    const { x, y } = toCanvasCoords(e);
    dragMoved = false;
    const tol = TOL();

    // Drag-to-connect: pressing a connect anchor of the hovered state starts a
    // new transition. Anchors are on the border and only show on hover, so this
    // can't be confused with grabbing the body to move it. Checked first.
    if (hover?.kind === 'state' && connectAnchorAt(doc.states[hover.index], x, y, tol * 1.6)) {
      drag = { kind: 'connect', fromIndex: hover.index, to: { x, y }, target: null };
      redraw();
      return;
    }

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
    const grabbed = handleAt(x, y);
    if (grabbed && selection?.kind === 'state') {
      const s = doc.states[selection.index];
      drag = { kind: 'resize', index: selection.index, handle: grabbed as StateHandle, startMouseX: x, startMouseY: y, origX0: s.x0, origY0: s.y0, origX1: s.x1, origY1: s.y1 };
      redraw();
      return;
    }
    if (grabbed && selection?.kind === 'transition') {
      drag = { kind: 'curve', index: selection.index, handle: grabbed as CurveHandle };
      redraw();
      return;
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

  // Hover: what's under the cursor when nothing is being dragged. The v1 canvas
  // never reacted to the mouse until you pressed a button, which is most of why
  // it felt inert. Only redraws when the answer actually changes.
  const hoverCursor = (h: Selection | null, handle: StateHandle | CurveHandle | null): string => {
    if (handle === 'tl' || handle === 'br') return 'nwse-resize';
    if (handle === 'tr' || handle === 'bl') return 'nesw-resize';
    if (handle) return 'grab'; // a curve endpoint / control point
    return h ? 'move' : 'default';
  };
  canvas.addEventListener('mousemove', (e) => {
    if (drag || pan) return;
    const { x, y } = toCanvasCoords(e);
    if (posEl) posEl.textContent = `${Math.round(x)}, ${Math.round(y)}`;
    // In pan mode the grab cursor wins over hover feedback.
    if (spaceHeld) return;
    let next = hitTest(ctx, doc, page, x, y);
    // A connect anchor sits just outside the border, where hitTest misses — keep
    // the state hovered while the cursor is on one, so its anchors stay grabbable.
    if (!next && hover?.kind === 'state' && connectAnchorAt(doc.states[hover.index], x, y, TOL() * 1.8)) {
      next = hover;
    }
    const onAnchor = next?.kind === 'state' && !!connectAnchorAt(doc.states[next.index], x, y, TOL() * 1.6);
    canvas.style.cursor = onAnchor ? 'crosshair' : hoverCursor(next, handleAt(x, y));
    if (selKeyOrNull(next) === selKeyOrNull(hover)) return;
    hover = next;
    redraw();
  });
  canvas.addEventListener('mouseleave', () => {
    if (posEl) posEl.textContent = '';
    if (!hover) return;
    hover = null;
    redraw();
  });

  window.addEventListener('mousemove', (e) => {
    if (pan) {
      const wrap = canvas.parentElement;
      if (wrap) {
        wrap.scrollLeft = pan.scrollL - (e.clientX - pan.startX);
        wrap.scrollTop = pan.scrollT - (e.clientY - pan.startY);
      }
      return;
    }
    if (!drag) return;
    const { x, y } = toCanvasCoords(e);
    if (drag.kind === 'connect') {
      dragMoved = true;
      drag.to = { x, y };
      const hit = hitTest(ctx, doc, page, x, y);
      drag.target = hit?.kind === 'state' ? hit.index : null;
      scheduleRedraw();
      return;
    }
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
      // Snap the dragged edges to the grid when it's on, like state moves.
      const g = doc.preferences.gridSize;
      const sn = (v: number) => (doc.preferences.grid ? snap(v, g) : v);
      if (h === 'tl' || h === 'bl') s.x0 = sn(drag.origX0 + dx);
      if (h === 'tr' || h === 'br') s.x1 = sn(drag.origX1 + dx);
      if (h === 'tl' || h === 'tr') s.y0 = sn(drag.origY0 + dy);
      if (h === 'bl' || h === 'br') s.y1 = sn(drag.origY1 + dy);
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
      let dx = x - drag.startMouseX, dy = y - drag.startMouseY;
      if (dx !== 0 || dy !== 0) dragMoved = true;
      // Snap the whole-group delta to the grid so the arrangement moves in grid
      // steps and keeps its relative layout (rather than snapping each object).
      if (doc.preferences.grid) {
        dx = snap(dx, doc.preferences.gridSize);
        dy = snap(dy, doc.preferences.gridSize);
      }
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
      const g = doc.preferences.gridSize;
      t.x = doc.preferences.grid ? snap(drag.origX + dx, g) : drag.origX + dx;
      t.y = doc.preferences.grid ? snap(drag.origY + dy, g) : drag.origY + dy;
    }
    scheduleRedraw();
  });

  window.addEventListener('mouseup', () => {
    if (pan) {
      pan = null;
      canvas.style.cursor = spaceHeld ? 'grab' : 'default';
      return;
    }
    if (drag && drag.kind === 'connect') {
      const { fromIndex, target } = drag;
      const moved = dragMoved;
      const from = doc.states[fromIndex];
      drag = null;
      // A plain click on an anchor (no drag) just selects the state, like
      // clicking its body. A drag ending over empty space is a cancel.
      if (!moved || target === null || !from) {
        if (!moved) selection = { kind: 'state', index: fromIndex };
        redraw();
        return;
      }
      // Drag to another state -> transition; back onto itself -> loopback.
      if (target === fromIndex) {
        const lp = createLoopback(doc, from, from.x0 + (from.x1 - from.x0) / 2, from.y0, page, defaults.loopbackColor);
        selection = { kind: 'transition', index: doc.transitions.indexOf(lp) };
      } else {
        const t = createTransition(doc, from, doc.states[target], page, defaults.transitionColor);
        selection = { kind: 'transition', index: doc.transitions.indexOf(t) };
      }
      group = [];
      resize();
      redraw();
      commit();
      return;
    }
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

  // A short human description of a selected object, for the delete flash.
  const describeObject = (sel: Selection): string => {
    if (sel.kind === 'state') return `state ${doc.states[sel.index]?.name ?? ''}`.trim();
    if (sel.kind === 'transition') return doc.transitions[sel.index]?.kind === 'loopback' ? 'loopback' : 'transition';
    return 'text';
  };

  const deleteFromMenu = (sel: Selection) => {
    const what = describeObject(sel);
    deleteSelection(doc, sel);
    selection = null;
    hover = null; // its index now points at a different object, or none
    redraw();
    commit();
    flashStatus(`Deleted ${what} — press Ctrl+Z to undo`);
  };

  // Deletes the current selection or multi-selection (shared by the Delete key
  // and the Edit → Delete menu item).
  const deleteSelected = () => {
    if (group.length > 0) {
      const n = group.length;
      const names = new Set(group.filter((g) => g.kind === 'state').map((g) => doc.states[g.index].name));
      const textIdx = group.filter((g) => g.kind === 'text').map((g) => g.index).sort((a, b) => b - a);
      doc.states = doc.states.filter((s) => !names.has(s.name));
      doc.transitions = doc.transitions.filter((t) =>
        t.kind === 'loopback' ? !names.has(t.state) : !names.has(t.startState) && !names.has(t.endState)
      );
      for (const i of textIdx) if (!doc.texts[i]?.isGlobalTable) doc.texts.splice(i, 1);
      group = [];
      selection = null;
      hover = null; // indices shifted under it
      redraw();
      commit();
      flashStatus(`Deleted ${n} objects — press Ctrl+Z to undo`);
    } else if (selection) {
      const what = describeObject(selection);
      deleteSelection(doc, selection);
      selection = null;
      hover = null;
      redraw();
      commit();
      flashStatus(`Deleted ${what} — press Ctrl+Z to undo`);
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
      rebuildEditBar(); // this state's own fields (name, outputs, …) may have just changed
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
      rebuildEditBar(); // this transition's own fields may have just changed
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
      rebuildEditBar();
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
      items.push({ label: 'Edit State Properties…', action: () => openProperties(hit) });
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
        label: isLoop ? 'Edit Loopback Properties…' : 'Edit Transition Properties…',
        action: () => openProperties(hit),
      });
      items.push({ label: isLoop ? 'Delete Loopback' : 'Delete Transition', action: () => deleteFromMenu(hit) });
    } else if (hit.kind === 'text' && !doc.texts[hit.index].isGlobalTable) {
      items.push({ label: 'Edit Text…', action: () => openProperties(hit) });
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

    // Hold Space to pan: the cursor becomes a grab hand and a left-drag scrolls
    // the view instead of selecting. preventDefault stops Space from scrolling
    // the page / clicking a focused button.
    if (e.code === 'Space' && !inField) {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        if (!pan) canvas.style.cursor = 'grab';
      }
      return;
    }

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
      // Debounce the commit so holding an arrow key (which can repeat at
      // >100Hz) doesn't serialize+round-trip the whole document, and create
      // an undo step, on every single pixel of movement.
      if (nudgeCommitTimer) clearTimeout(nudgeCommitTimer);
      nudgeCommitTimer = setTimeout(() => { nudgeCommitTimer = null; commit(); }, 300);
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

    // Enter opens the property dialog for the current selection — the
    // keyboard path to the same modal double-click opens.
    if (e.key === 'Enter' && !inField && selection && group.length === 0) {
      e.preventDefault();
      if (!(selection.kind === 'text' && doc.texts[selection.index]?.isGlobalTable)) openProperties(selection);
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

  // Releasing Space leaves pan mode. If a pan drag is still in progress the
  // mouseup handler resets the cursor; otherwise clear it here.
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceHeld = false;
      if (!pan) canvas.style.cursor = 'default';
    }
  });
  // Losing focus (Alt-Tab away mid-pan) shouldn't leave Space "stuck" held.
  window.addEventListener('blur', () => {
    spaceHeld = false;
    if (!pan) canvas.style.cursor = 'default';
  });

  // Two editing surfaces, no overlap: the edit bar (always visible, common
  // fields, live) and — for the rare full-attribute edit — the complete property
  // dialog opened here. Double-click / Enter / right-click "Properties" all reach
  // it; a label counts as its parent object (labels are for moving, not editing
  // in place). No nested dialogs: this IS the full editor.
  const openProperties = (sel: Selection) => {
    if (sel.kind === 'state') openStateDialog(sel.index);
    else if (sel.kind === 'transition') openTransitionDialog(sel.index);
    else if (sel.kind === 'text' && !doc.texts[sel.index]?.isGlobalTable) openTextDialog(sel.index);
  };

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = toCanvasCoords(e);
    const labelHit = hitAttrLabel(ctx, doc, page, x, y);
    if (labelHit) { openProperties({ kind: labelHit.kind, index: labelHit.index }); return; }
    const hit = hitTest(ctx, doc, page, x, y);
    if (hit) openProperties(hit);
  });

  // The edit bar: the everyday editing surface (common fields, live). Its
  // "All attributes…" button opens the same complete dialog double-click does.
  const editBarEl = document.getElementById('editbar');
  if (editBarEl) {
    const editBar = buildEditBar(editBarEl, {
      getDoc: () => doc,
      getSelection: () => selection,
      getGroup: () => group,
      redraw,
      commit,
      message: (m) => void showMessage(m),
      openAllAttributes: openProperties,
      // The pin is a view pref (not in the .fzm): seeded from the injected
      // setting, written back through the host so it survives a reload.
      getExpanded: () => (window as unknown as { __FZM_EDITBAR_EXPANDED__?: boolean }).__FZM_EDITBAR_EXPANDED__ === true,
      setExpanded: (v) => vscode.postMessage({ type: 'setEditBarExpanded', value: v }),
    });
    refreshEditBar = () => editBar.refresh();
    rebuildEditBar = () => editBar.rebuild();
    editBar.refresh();
  }

  // Export the current page as an image. Java exports into a fresh image that is
  // always light and always 1:1 (FizzimGui.exportFile), so render offscreen
  // rather than snapshotting the live canvas — otherwise the current zoom and
  // surface mode get baked in. Selection/marquee are excluded too.
  //
  // The 'export' surface mode is white/black no matter what the user is working
  // in: these diagrams get sent to coworkers and printed, and white is the house
  // standard, so a dark-theme session must never produce a dark PNG.
  const exportImage = (mime: 'image/png' | 'image/jpeg') => {
    const { width, height } = computeBounds(doc, page);
    const off = document.createElement('canvas');
    off.width = Math.round(width);
    off.height = Math.round(height);
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    render(offCtx, doc, page, null, {
      zoom: 1,
      theme: readTheme('export'),
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
  const openPreferences = () => {
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
        if (gridToggle) gridToggle.checked = p.grid;
        if (tableToggle) tableToggle.checked = p.tableVis;
        resize();
        redraw();
        commit();
      });
  };

  const openGlobals = (tab: number) => {
    void showGlobalEditor(doc, tab).then((result) => {
      if (!result) return;
      doc = result;
      selection = null;
      resize();
      redraw();
      commit();
    });
  };

  // Fizzim's Page Setup: the canvas pixel dimensions, stored in the .fzm
  // preferences. syncPageInputs is a no-op kept so existing callers don't need
  // changing (it fed the old inline W×H toolbar inputs).
  const syncPageInputs = () => {};
  const openPageSetup = () => {
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
  };

  const fitPage = () => {
    // Measure content alone (floorToPage=false): flooring at the current page
    // size would make each click grow the page by the bounds margin.
    const b = computeBounds(doc, page, false);
    doc.preferences.pageSizeW = Math.max(100, Math.round(b.width));
    doc.preferences.pageSizeH = Math.max(100, Math.round(b.height));
    syncPageInputs();
    resize();
    redraw();
    commit();
  };

  const tableToggle = document.getElementById('table-toggle') as HTMLInputElement | null;
  const gridToggle = document.getElementById('grid-toggle') as HTMLInputElement | null;
  const surfaceToggle = document.getElementById('surface-toggle') as HTMLInputElement | null;

  // Grid and Table are document preferences (they live in the .fzm), so toggling
  // them is an edit. The surface is a view preference and is persisted to the
  // fizzim.canvasSurface setting instead — toggling it must never dirty the file.
  const setGrid = (on: boolean) => {
    doc.preferences.grid = on;
    if (gridToggle) gridToggle.checked = on;
    redraw();
    commit();
  };
  const setTable = (on: boolean) => {
    doc.preferences.tableVis = on;
    if (tableToggle) tableToggle.checked = on;
    redraw();
    commit();
  };
  const setSurface = (mode: SurfaceMode) => {
    surface = mode;
    invalidateTheme();
    if (surfaceToggle) surfaceToggle.checked = mode === 'theme';
    redraw();
    vscode.postMessage({ type: 'setCanvasSurface', value: mode });
  };

  const about = () =>
    showMessage(
      'Fizzim for VS Code — a community port of Fizzim (Zimmer Design Services). ' +
        'Draw finite-state machines and generate synthesizable Verilog/VHDL. GPL-3.0-or-later.'
    );

  // Everything the v1 menu bar could do, as named actions. The host drives these
  // by name (see `invoke` in extension.ts) from the title bar, the Command
  // Palette and keybindings; the toolbar below calls the same functions.
  const actions: Record<string, (arg?: unknown) => void> = {
    zoomIn: () => applyZoom(zoom * 1.25),
    zoomOut: () => applyZoom(zoom / 1.25),
    zoomReset: () => applyZoom(1),
    zoomFit: () => fitToView(),
    fitPage,
    toggleGrid: () => setGrid(!doc.preferences.grid),
    toggleTable: () => setTable(!doc.preferences.tableVis),
    toggleSurface: () => setSurface(surface === 'theme' ? 'paper' : 'theme'),
    preferences: () => openPreferences(),
    pageSetup: openPageSetup,
    viewAsText: () => vscode.postMessage({ type: 'viewAsText' }),
    about: () => void about(),
    globals: (arg) => openGlobals(Number(arg) || 0),
    generate: (arg) =>
      vscode.postMessage({
        type: 'generate',
        text: serializeFzm(doc),
        language: String(arg || 'verilog'),
        customArgs: doc.preferences.customArgs,
      }),
    export: (arg) => exportImage(arg === 'image/jpeg' ? 'image/jpeg' : 'image/png'),
  };

  // --- Toolbar. The document actions sit next to the canvas rather than in the
  // editor title bar; they're the same functions the commands call.
  document.getElementById('new-btn')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'command', command: 'fizzim.newDiagram' })
  );
  document.getElementById('generate-btn')?.addEventListener('click', () =>
    // Language choice is the host's QuickPick, so the toolbar and the Command
    // Palette ask the same question rather than each having their own answer.
    vscode.postMessage({ type: 'command', command: 'fizzim.generateHdl' })
  );
  document.getElementById('export-btn')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'command', command: 'fizzim.exportImage' })
  );
  document.getElementById('globals-btn')?.addEventListener('click', () => openGlobals(0));

  // --- Zoom: a status-bar button opening our own menu, anchored to its top edge
  // so it flies up over the canvas instead of off the bottom of the window.
  zoomBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = zoomBtn.getBoundingClientRect();
    const pct = `${Math.round(zoom * 100)}%`;
    showContextMenu(
      r.left,
      r.top,
      [
        { label: 'Zoom In', action: () => actions.zoomIn() },
        { label: 'Zoom Out', action: () => actions.zoomOut() },
        { label: 'Fit to Window', action: () => fitToView() },
        { label: 'Fit Page to Drawing', action: () => fitPage() },
        ...[0.5, 0.75, 1, 1.5, 2].map((z) => ({
          label: `${z * 100}%`,
          action: () => applyZoom(z),
        })),
      ],
      { above: true, checked: pct }
    );
  });
  if (tableToggle) {
    tableToggle.checked = doc.preferences.tableVis;
    tableToggle.addEventListener('change', () => setTable(tableToggle.checked));
  }
  if (gridToggle) {
    gridToggle.checked = doc.preferences.grid;
    gridToggle.addEventListener('change', () => setGrid(gridToggle.checked));
  }
  if (surfaceToggle) {
    surfaceToggle.checked = surface === 'theme';
    surfaceToggle.addEventListener('change', () => setSurface(surfaceToggle.checked ? 'theme' : 'paper'));
  }

  // Ctrl/Cmd + mouse wheel zooms toward the cursor, like every modern diagram
  // editor — the point under the mouse stays put instead of drifting.
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoomAt(e.deltaY < 0 ? zoom * 1.1 : zoom / 1.1, e.clientX, e.clientY);
    },
    { passive: false }
  );


  // External edits (e.g. the file changed on disk, or an undo): re-parse and
  // redraw. Selection/drag state is dropped, which is fine for an outside edit.
  window.addEventListener('message', (e) => {
    const msg = e.data;
    // A command fired from the editor title bar, the Command Palette or a
    // keybinding. The host doesn't know what any of them mean — it just relays
    // the name to whichever diagram is focused.
    if (msg && msg.type === 'invoke' && typeof msg.id === 'string') {
      actions[msg.id]?.(msg.arg);
      return;
    }
    if (msg && msg.type === 'externalUpdate' && typeof msg.text === 'string') {
      doc = parseOrDefault(msg.text);
      if (page > doc.tabs.length) page = 1;
      selection = null;
      hover = null; // a whole new doc: every index is meaningless now
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
