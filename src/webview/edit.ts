import { FzmDocument, FzmLoopback, FzmState, FzmText, FzmTransition, ObjAttribute } from '../fzm/model';
import { Selection } from './hitTest';
import { createLoopbackGeometry, createStubGeometry, moveTransition, recomputeCrossPage, recomputeLoopback, recomputeStub, recomputeTransition } from './geometry';
import { updateAttrib } from './globals';

const DEFAULT_STATE_W = 130; // matches DrawArea's default StateW/StateH
const DEFAULT_STATE_H = 130;

// Simplification vs. the Java source: Fizzim persists SCounter/TCounter in the
// .fzm file so new names stay unique even across sessions after deletions
// (see FileParser's <SCounter>/<TCounter>, dropped in Phase 1). We derive the
// next name by scanning instead - good enough until Phase 8 needs full
// round-trip fidelity with the counters themselves.
function nextName(existingNames: string[], prefix: string): string {
  let max = -1;
  for (const name of existingNames) {
    if (!name.startsWith(prefix)) continue;
    const n = Number(name.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

// A brand-new per-object attribute added via the property dialog's "New"
// button (Fizzim's SPNew/TPNew). All statuses LOCAL so every cell is editable
// and it's deletable per-object; visible by default so it shows on the canvas.
export function newLocalAttribute(name: string, page = -1): ObjAttribute {
  return {
    name, nameStatus: 'LOCAL', value: '', valueStatus: 'LOCAL',
    visibility: 1, visibilityStatus: 'LOCAL', type: '', typeStatus: 'LOCAL',
    comment: '', commentStatus: 'LOCAL', color: -16777216, colorStatus: 'LOCAL',
    useratts: '', userattsStatus: 'LOCAL', resetval: '', resetvalStatus: 'LOCAL',
    x2Obj: 0, y2Obj: 0, page,
  };
}

export function createState(
  doc: FzmDocument,
  x: number,
  y: number,
  page: number,
  color = -16777216,
  w = DEFAULT_STATE_W,
  h = DEFAULT_STATE_H
): FzmState {
  const name = nextName(doc.states.map((s) => s.name), 'state');
  const state: FzmState = {
    name,
    x0: Math.round(x - w / 2),
    y0: Math.round(y - h / 2),
    x1: Math.round(x + w / 2),
    y1: Math.round(y + h / 2),
    reset: false,
    page,
    color,
    attributes: [],
  };
  doc.states.push(state);
  // Seeds every currently-declared state attribute (name, outputs, custom
  // attrs) onto the new state, mirroring Java's `state.updateAttrib(globalList,
  // 3)` right after construction - not just on the next Global Attributes
  // reconcile.
  updateAttrib(name, state.attributes, doc.stateAttrs, page);
  return state;
}

// Makes a deep copy of a state, offset by (dx, dy), with a fresh unique name.
export function duplicateState(doc: FzmDocument, index: number, dx = 40, dy = 40): FzmState {
  const src = doc.states[index];
  const copy: FzmState = JSON.parse(JSON.stringify(src));
  copy.name = nextName(doc.states.map((s) => s.name), 'state');
  copy.x0 += dx; copy.y0 += dy; copy.x1 += dx; copy.y1 += dy;
  copy.reset = false; // only one reset state; a copy is never the reset state
  const nameAttr = copy.attributes.find((a) => a.name === 'name');
  if (nameAttr) nameAttr.value = copy.name;
  doc.states.push(copy);
  return copy;
}

export function createText(doc: FzmDocument, x: number, y: number, page: number, text: string): FzmText {
  const textObj: FzmText = { text, isGlobalTable: false, x: Math.round(x), y: Math.round(y), page };
  doc.texts.push(textObj);
  return textObj;
}

export function createLoopback(doc: FzmDocument, state: FzmState, x: number, y: number, page: number, color = -16777216): FzmLoopback {
  const name = nextName(
    doc.transitions.map((t) => t.name),
    'trans'
  );
  const geo = createLoopbackGeometry(state, { x, y });
  const loopback: FzmLoopback = {
    kind: 'loopback',
    name,
    state: state.name,
    ...geo,
    page,
    color,
    attributes: [],
  };
  doc.transitions.push(loopback);
  // Seeds every currently-declared transition attribute (name, equation,
  // priority, graycode, custom attrs) onto the new loopback, mirroring Java's
  // `trans.updateAttrib(globalList, 4)` right after construction - not just on
  // the next Global Attributes reconcile.
  updateAttrib(name, loopback.attributes, doc.transAttrs, page);
  return loopback;
}

export function createTransition(doc: FzmDocument, startState: FzmState, endState: FzmState, page: number, color = -16777216): FzmTransition {
  const name = nextName(
    doc.transitions.map((t) => t.name),
    'trans'
  );
  const transition: FzmTransition = {
    kind: 'transition',
    name,
    startState: startState.name,
    endState: endState.name,
    startPt: { x: 0, y: 0 },
    endPt: { x: 0, y: 0 },
    startCtrlPt: { x: 0, y: 0 },
    endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0,
    endStateIndex: 0,
    page,
    color,
    pageS: { x: 0, y: 0 },
    pageSC: { x: 0, y: 0 },
    pageE: { x: 0, y: 0 },
    pageEC: { x: 0, y: 0 },
    stub: false,
    attributes: [],
  };
  // Pushed before seeding geometry: recomputeCrossPage's sibling-stagger offset
  // (crossPageOffset) looks this transition up in doc.transitions by identity.
  doc.transitions.push(transition);
  // Seeds every currently-declared transition attribute (name, equation,
  // priority, graycode, custom attrs) onto the new transition, mirroring
  // Java's `trans.updateAttrib(globalList, 4)` right after construction - not
  // just on the next Global Attributes reconcile. Otherwise e.g. a priority
  // already declared via Global Attributes silently wouldn't show up on any
  // transition created afterward, until Global Attributes was reopened.
  updateAttrib(name, transition.attributes, doc.transAttrs, page);
  // A transition created between two states that already live on different
  // pages seeds the cross-page connector (pentagon "road sign" docked at the
  // page edge) instead of the same-page bezier - which would otherwise aim at
  // (0,0) forever, since startPt/endPt/control points are never touched again
  // until something moves. Mirrors StateTransitionObj.setEndPts' own branch.
  if (startState.page !== endState.page) recomputeCrossPage(doc, transition);
  else recomputeTransition(transition, startState, endState);
  return transition;
}

export interface EditResult {
  ok: boolean;
  error?: string;
}

// Re-pages a normal transition's own `page` field and its attribute labels
// after either endpoint's page changes (the state itself moved to another
// page, or the transition got reconnected to a state on another page).
// Mirrors StateTransitionObj.updateObj's cascade: a label that was on the old
// start/end page follows its endpoint to the new one; a transition that just
// became cross-page (it wasn't before - oldStartPage === oldEndPage) dumps
// every label onto the new start page, since Java doesn't split labels across
// pages except via the user's explicit "Move to Page". The transition's own
// page always tracks its start state's page, like Java's myPage = sPage.
function repageTransition(t: FzmTransition, oldStartPage: number, oldEndPage: number, newStartPage: number, newEndPage: number): void {
  if (oldStartPage !== newStartPage && oldStartPage !== oldEndPage) {
    for (const a of t.attributes) if (a.page === oldStartPage) a.page = newStartPage;
  }
  if (oldEndPage !== newEndPage && oldStartPage !== oldEndPage) {
    for (const a of t.attributes) if (a.page === oldEndPage) a.page = newEndPage;
  }
  if (newStartPage !== newEndPage && oldStartPage === oldEndPage) {
    for (const a of t.attributes) a.page = newStartPage;
  }
  t.page = newStartPage;
}

// Moves a state (and its attributes + attached loopbacks) to another page.
// Normal transitions to states still on other pages become cross-page and are
// simply not drawn until both endpoints share a page again.
export function moveStateToPage(doc: FzmDocument, index: number, newPage: number): void {
  const s = doc.states[index];
  const name = s.name;
  // Pre-move snapshot of every state's page, so the re-page cascade below can
  // tell what each attached transition's endpoints' pages *were*.
  const oldPageOf = new Map(doc.states.map((st) => [st.name, st.page]));
  s.page = newPage;
  for (const a of s.attributes) a.page = newPage;
  for (const t of doc.transitions) {
    if (t.kind === 'loopback' && t.state === name) {
      t.page = newPage;
      for (const a of t.attributes) a.page = newPage;
    }
  }
  // A normal transition touching the moved state may have just become — or
  // stopped being — cross-page. Re-seed its geometry either way, like Java.
  const byName = new Map(doc.states.map((st) => [st.name, st]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') continue;
    if (t.startState !== name && t.endState !== name) continue;
    const a = byName.get(t.startState);
    const b = byName.get(t.endState);
    if (!a || !b) continue;
    repageTransition(t, oldPageOf.get(t.startState)!, oldPageOf.get(t.endState)!, a.page, b.page);
    if (a.page !== b.page) recomputeCrossPage(doc, t);
    else recomputeTransition(t, a, b);
  }
}

// Moves a free-text object to another page (Fizzim's text right-click "Move to
// Page"). No cascade — text has no attached objects.
export function moveTextToPage(doc: FzmDocument, index: number, newPage: number): void {
  const t = doc.texts[index];
  if (t && !t.isGlobalTable) t.page = newPage;
}

// Deletes a page (1-based) and everything on it, mirroring Java's
// DrawArea.removePage: a transition dies when EITHER endpoint state's page is
// the deleted page (endpoint pages are looked up BEFORE the states are
// removed); pages above the deleted one shift down by one, including every
// attribute's own page (Java's decrementPage loops the attribute list too).
export function deletePage(doc: FzmDocument, pnum: number): void {
  const statePage = new Map(doc.states.map((s) => [s.name, s.page]));
  doc.transitions = doc.transitions.filter((t) => {
    if (t.kind === 'loopback') return statePage.get(t.state) !== pnum;
    return statePage.get(t.startState) !== pnum && statePage.get(t.endState) !== pnum;
  });
  doc.states = doc.states.filter((s) => s.page !== pnum);
  doc.texts = doc.texts.filter((t) => t.page !== pnum || t.isGlobalTable);
  doc.tabs.splice(pnum - 1, 1);
  const dec = (attrs: ObjAttribute[]) => {
    for (const a of attrs) if (a.page > pnum) a.page--;
  };
  for (const s of doc.states) { if (s.page > pnum) s.page--; dec(s.attributes); }
  for (const t of doc.transitions) { if (t.page > pnum) t.page--; dec(t.attributes); }
  for (const t of doc.texts) if (t.page > pnum) t.page--;
}

function setAttrValue(attributes: ObjAttribute[], name: string, value: string): void {
  const attr = attributes.find((a) => a.name === name);
  if (attr) attr.value = value;
}

export function getAttrValue(attributes: ObjAttribute[], name: string): string {
  return attributes.find((a) => a.name === name)?.value ?? '';
}

// The type="output" attributes on a state — one per declared output. Their
// `value` is that output's value in this state ("" = use the output's default).
export function stateOutputAttributes(state: FzmState): ObjAttribute[] {
  return state.attributes.filter((a) => a.type === 'output');
}

// Converts between the stored integer color (signed 32-bit ARGB-ish; the
// renderer reads the low 24 bits as RGB) and a hex string.
export function colorIntToHex(rgb: number): string {
  const v = (rgb & 0xffffff).toString(16).padStart(6, '0');
  return `#${v}`;
}
export function hexToColorInt(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return -16777216; // fall back to black
  // Match Java's Color.getRGB(): 0xFF000000 | rgb  (as a signed 32-bit int)
  return (0xff000000 | parseInt(m[1], 16)) | 0;
}

// Sets an output's value for a single state. A non-empty value is a local
// override (valueStatus LOCAL, matching Java's editable[1]=LOCAL); clearing it
// reverts to the output's default (GLOBAL_VAR).
export function setStateOutputValue(state: FzmState, attrName: string, value: string): void {
  const attr = state.attributes.find((a) => a.name === attrName && a.type === 'output');
  if (!attr) return;
  attr.value = value;
  attr.valueStatus = value.trim() ? 'LOCAL' : 'GLOBAL_VAR';
}

// --- Transition (Mealy) output values ------------------------------------
// An output can also be driven on a transition. Unlike states (which get a
// type="output" attribute for every declared output up front), a transition
// only carries a type="output" attribute for outputs actually set on it — we
// add one on demand and remove it when cleared.

function makeAttr(name: string, value: string, page: number, type: string, visibility: number): ObjAttribute {
  return {
    name, nameStatus: 'GLOBAL_FIXED', value, valueStatus: 'LOCAL',
    visibility, visibilityStatus: 'GLOBAL_VAR', type, typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page,
  };
}

function makeOutputAttribute(name: string, value: string, page: number): ObjAttribute {
  // visibility 2 = "only non-default", matching how Fizzim writes a transition
  // output attribute (verified against real cliff_mealy_ontransition.fzm).
  return makeAttr(name, value, page, 'output', 2);
}

export function getTransitionOutputValue(t: FzmTransition | FzmLoopback, name: string): string {
  return t.attributes.find((a) => a.name === name && a.type === 'output')?.value ?? '';
}

// The rows shown in a transition's property table: the transition's own
// attributes, plus a placeholder row for every declared output not yet driven
// here (so any Mealy output can be set straight from the table). The
// placeholders are throwaway objects until reconcileTransitionOutputs runs.
export function transitionDialogAttributes(t: FzmTransition | FzmLoopback, outputs: ObjAttribute[]): ObjAttribute[] {
  const rows = [...t.attributes];
  for (const o of outputs) {
    if (!rows.some((a) => a.name === o.name && a.type === 'output')) {
      rows.push(makeOutputAttribute(o.name, '', t.page));
    }
  }
  return rows;
}

// After the table is edited, syncs the transition's stored output attributes
// with the (mutated) working rows: non-empty stays/updates, empty is removed.
export function reconcileTransitionOutputs(t: FzmTransition | FzmLoopback, working: ObjAttribute[]): void {
  for (const a of working) {
    if (a.type === 'output') setTransitionOutputValue(t, a.name, a.value);
  }
}

// Sets (or clears) an output's value on a transition. Non-empty adds/updates a
// type="output" attribute; empty removes it.
export function setTransitionOutputValue(t: FzmTransition | FzmLoopback, name: string, value: string): void {
  const idx = t.attributes.findIndex((a) => a.name === name && a.type === 'output');
  if (value.trim()) {
    if (idx >= 0) {
      t.attributes[idx].value = value;
      t.attributes[idx].valueStatus = 'LOCAL';
    } else {
      t.attributes.push(makeOutputAttribute(name, value, t.page));
    }
  } else if (idx >= 0) {
    t.attributes.splice(idx, 1);
  }
}

// --- Full attribute-table editing (mirrors Java's MyTableModel) -----------
// The property dialogs show every attribute in an 8-column table, exactly like
// Fizzim's StateProperties/TransProperties. Columns (matching MyTableModel):
//   0 Name  1 Value  2 Visibility  3 Type  4 Comment  5 Color  6 UserAtts  7 ResetValue
export const ATTR_COLUMN_LABELS = ['Attribute Name', 'Value', 'Visibility', 'Type', 'Comment', 'Color', 'UserAtts', 'ResetValue'];

// The per-column status field on ObjAttribute, indexed by column (0..7).
const STATUS_FIELDS: (keyof ObjAttribute)[] = [
  'nameStatus', 'valueStatus', 'visibilityStatus', 'typeStatus', 'commentStatus', 'colorStatus', 'userattsStatus', 'resetvalStatus',
];

// Whether a cell is editable in a *local* (state/transition) dialog. Java's
// isCellEditable returns false for ABS (never editable) and GLOBAL_FIXED
// (only editable in the Global Attributes dialog); GLOBAL_VAR and LOCAL are
// editable here.
export function attrCellEditable(a: ObjAttribute, col: number): boolean {
  const status = a[STATUS_FIELDS[col]] as string;
  return status === 'GLOBAL_VAR' || status === 'LOCAL';
}

// The stored value for a column (visibility & color are numbers, the rest strings).
export function attrColValue(a: ObjAttribute, col: number): string | number {
  switch (col) {
    case 0: return a.name;
    case 1: return a.value;
    case 2: return a.visibility;
    case 3: return a.type;
    case 4: return a.comment;
    case 5: return a.color;
    case 6: return a.useratts;
    case 7: return a.resetval;
    default: return '';
  }
}

// One attribute row's editable values collected from the dialog. Locked cells
// are re-sent unchanged; the applier skips them.
export interface AttrRowEdit {
  name?: string; // only honoured for LOCAL attributes (see applyAttributeEdits)
  value: string;
  visibility: number;
  type: string; // already translated back from the "statebit" display to "reg"
  comment: string;
  color: number;
  useratts: string;
  resetval: string;
}

function setAttrCol(a: ObjAttribute, col: number, value: string | number, globalDefaults: ObjAttribute[]): void {
  if (!attrCellEditable(a, col)) return; // never touch a locked cell
  if (attrColValue(a, col) === value) return; // unchanged - keep its status too
  // Clearing the Value column reverts to the global default (Java's
  // updateAttrib restore-on-empty), so e.g. blanking an output uses its default.
  if (col === 1 && value === '') {
    const g0 = globalDefaults.find((d) => d.name === a.name);
    a.value = g0 ? g0.value : '';
    a.valueStatus = 'GLOBAL_VAR';
    return;
  }
  switch (col) {
    case 1: a.value = String(value); break;
    case 2: a.visibility = Number(value); break;
    case 3: a.type = String(value); break;
    case 4: a.comment = String(value); break;
    case 5: a.color = Number(value); break;
    case 6: a.useratts = String(value); break;
    case 7: a.resetval = String(value); break;
  }
  // Mark the column LOCAL if it now differs from the global default, else
  // GLOBAL_VAR (Java's checkValue path). Status only affects the .fzm <status>
  // blocks, which fizzim.pl ignores; we keep it faithful for round-tripping.
  const g = globalDefaults.find((d) => d.name === a.name);
  const matchesGlobal = g ? attrColValue(g, col) === value : false;
  (a[STATUS_FIELDS[col]] as string) = matchesGlobal ? 'GLOBAL_VAR' : 'LOCAL';
}

// Applies the edited rows back onto an attribute list. The 'name' row's value is
// applied here too, but the caller must have already renamed the object (which
// validates uniqueness and sets that same value), so it's a no-op skip.
// `globalDefaults` is doc.stateAttrs for a state, doc.transAttrs for a transition.
export function applyAttributeEdits(attributes: ObjAttribute[], edits: AttrRowEdit[], globalDefaults: ObjAttribute[]): void {
  attributes.forEach((a, i) => {
    const e = edits[i];
    if (!e) return;
    // Java lets you rename an attribute you added (name-status LOCAL). Empty or
    // duplicate names are ignored — the row keeps its old name.
    if (
      e.name !== undefined &&
      a.nameStatus === 'LOCAL' &&
      e.name &&
      e.name !== a.name &&
      !attributes.some((o) => o !== a && o.name === e.name)
    ) {
      a.name = e.name;
    }
    setAttrCol(a, 1, e.value, globalDefaults);
    setAttrCol(a, 2, e.visibility, globalDefaults);
    setAttrCol(a, 3, e.type, globalDefaults);
    setAttrCol(a, 4, e.comment, globalDefaults);
    setAttrCol(a, 5, e.color, globalDefaults);
    setAttrCol(a, 6, e.useratts, globalDefaults);
    setAttrCol(a, 7, e.resetval, globalDefaults);
  });
}

// Reverts any local attribute typed "output" whose name isn't a declared global
// output back to a plain attribute (Java MyTableModel.setValueAt: an object
// attribute can only be type "output" if that name exists in the Outputs tab).
// Guards against a stray "output" type creating a dangling output reference in
// the generated HDL. `outputs` is doc.outputs.
export function sanitizeLocalOutputTypes(attributes: ObjAttribute[], outputs: ObjAttribute[]): void {
  for (const a of attributes) {
    if (a.type === 'output' && !outputs.some((o) => o.name === a.name)) {
      a.type = '';
    }
  }
}

// Sets/clears a transition's "render as a stub" flag (Fizzim's TransProperties
// "Stub?" checkbox). Only meaningful for normal (non-loopback) transitions.
// Toggling on seeds the stub geometry (anchor + tip); toggling off recomputes
// the normal bezier curve - mirroring Java's setStub + setEndPts on redraw.
export function setTransitionStub(doc: FzmDocument, t: FzmTransition | FzmLoopback, stub: boolean): void {
  if (t.kind !== 'transition' || t.stub === stub) return;
  t.stub = stub;
  if (stub) {
    const start = doc.states.find((s) => s.name === t.startState);
    if (start) {
      const geo = createStubGeometry(start);
      t.startStateIndex = geo.startStateIndex;
      t.startPt = geo.startPt;
      t.pageS = geo.pageS;
    }
  } else {
    const start = doc.states.find((s) => s.name === t.startState);
    const end = doc.states.find((s) => s.name === t.endState);
    if (start && end) recomputeTransition(t, start, end);
  }
}

// Renames a state, cascading to every transition/loopback that references it and
// to the machine's reset_state attribute if it pointed at the old name.
export function renameState(doc: FzmDocument, index: number, newName: string): EditResult {
  newName = newName.trim();
  if (!newName) return { ok: false, error: 'State name cannot be empty.' };
  const state = doc.states[index];
  if (newName === state.name) return { ok: true };
  if (doc.states.some((s, i) => i !== index && s.name === newName)) {
    return { ok: false, error: `A state named "${newName}" already exists.` };
  }

  const oldName = state.name;
  state.name = newName;
  setAttrValue(state.attributes, 'name', newName);
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') {
      if (t.state === oldName) t.state = newName;
    } else {
      if (t.startState === oldName) t.startState = newName;
      if (t.endState === oldName) t.endState = newName;
    }
  }
  const resetState = doc.machine.find((a) => a.name === 'reset_state');
  if (resetState && resetState.value === oldName) resetState.value = newName;
  return { ok: true };
}

// Marks exactly one state as the reset state: sets its stored reset flag (and
// clears the others) and updates the machine reset_state attribute if present.
export function setResetState(doc: FzmDocument, index: number, isReset: boolean): void {
  if (isReset) {
    doc.states.forEach((s, i) => (s.reset = i === index));
    const resetState = doc.machine.find((a) => a.name === 'reset_state');
    if (resetState) resetState.value = doc.states[index].name;
  } else {
    doc.states[index].reset = false;
    const resetState = doc.machine.find((a) => a.name === 'reset_state');
    if (resetState && resetState.value === doc.states[index].name) resetState.value = '';
  }
}

// Resizes a state (top-left corner stays put, like Java StateObj.setSize) and
// re-routes its attached transitions/loopbacks (their endpoints sit on the
// state border, which moves when the size changes).
export function resizeState(doc: FzmDocument, index: number, width: number, height: number): void {
  const s = doc.states[index];
  const w = Math.max(10, Math.round(width));
  const h = Math.max(10, Math.round(height));
  s.x1 = s.x0 + w;
  s.y1 = s.y0 + h;
  const byName = new Map(doc.states.map((st) => [st.name, st]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') {
      if (t.state === s.name) recomputeLoopback(t, s);
    } else if (t.stub) {
      if (t.startState === s.name) recomputeStub(t, s);
    } else if (t.startState === s.name || t.endState === s.name) {
      const a = byName.get(t.startState);
      const b = byName.get(t.endState);
      if (a && b) {
        if (a.page !== b.page) recomputeCrossPage(doc, t);
        else moveTransition(t, a, b);
      }
    }
  }
}

export function renameTransition(doc: FzmDocument, index: number, newName: string): EditResult {
  newName = newName.trim();
  if (!newName) return { ok: false, error: 'Transition name cannot be empty.' };
  const t = doc.transitions[index];
  if (newName === t.name) return { ok: true };
  if (doc.transitions.some((o, i) => i !== index && o.name === newName)) {
    return { ok: false, error: `A transition named "${newName}" already exists.` };
  }
  t.name = newName;
  setAttrValue(t.attributes, 'name', newName);
  return { ok: true };
}

export function setEquation(t: FzmTransition | FzmLoopback, equation: string): void {
  setAttrValue(t.attributes, 'equation', equation);
}

export function getPriority(t: FzmTransition | FzmLoopback): string {
  return t.attributes.find((a) => a.name === 'priority')?.value ?? '';
}

export function setPriority(t: FzmTransition | FzmLoopback, value: string): void {
  const attr = t.attributes.find((a) => a.name === 'priority');
  if (value.trim()) {
    if (attr) {
      attr.value = value;
      attr.valueStatus = 'LOCAL';
    } else {
      // Priority is not type "output"; it's a plain attribute (type '').
      // visibility 2 matches how Fizzim stores it on transitions.
      t.attributes.push(makeAttr('priority', value, t.page, '', 2));
    }
  } else if (attr) {
    t.attributes.splice(t.attributes.indexOf(attr), 1);
  }
}

// Reconnects a normal transition to (possibly) different start/end states and
// recomputes its curve. Rejects start === end (that would be a loopback).
export function reconnectTransition(doc: FzmDocument, index: number, startName: string, endName: string): EditResult {
  if (startName === endName) return { ok: false, error: 'Start and end states must differ.' };
  const t = doc.transitions[index];
  if (t.kind !== 'transition') return { ok: false, error: 'Not a state transition.' };
  const start = doc.states.find((s) => s.name === startName);
  const end = doc.states.find((s) => s.name === endName);
  if (!start || !end) return { ok: false, error: 'Unknown state.' };
  const oldStart = doc.states.find((s) => s.name === t.startState);
  const oldEnd = doc.states.find((s) => s.name === t.endState);
  repageTransition(t, oldStart?.page ?? t.page, oldEnd?.page ?? t.page, start.page, end.page);
  t.startState = startName;
  t.endState = endName;
  // Reconnecting to a state on another page may make this transition
  // cross-page (or same-page again) - re-seed the right geometry either way,
  // just like a state move (moveStateToPage / StateTransitionObj.setEndPts).
  if (start.page !== end.page) recomputeCrossPage(doc, t);
  else recomputeTransition(t, start, end);
  return { ok: true };
}

// Re-attaches a loopback to a (possibly different) state and rebuilds its
// geometry anchored on that state — Fizzim's loopback "State:" dropdown.
export function reconnectLoopback(doc: FzmDocument, index: number, stateName: string): EditResult {
  const t = doc.transitions[index];
  if (t.kind !== 'loopback') return { ok: false, error: 'Not a loopback.' };
  const state = doc.states.find((s) => s.name === stateName);
  if (!state) return { ok: false, error: 'Unknown state.' };
  if (t.state === stateName) return { ok: true };
  t.state = stateName;
  t.page = state.page;
  // Anchor the loopback off the top of the new state (same default as a freshly
  // created loopback), then move its attribute pages along with it.
  const geo = createLoopbackGeometry(state, { x: (state.x0 + state.x1) / 2, y: state.y0 });
  t.startStateIndex = geo.startStateIndex;
  t.endStateIndex = geo.endStateIndex;
  t.startPt = geo.startPt;
  t.endPt = geo.endPt;
  t.startCtrlPt = geo.startCtrlPt;
  t.endCtrlPt = geo.endCtrlPt;
  for (const a of t.attributes) a.page = state.page;
  return { ok: true };
}

export function deleteSelection(doc: FzmDocument, selection: Selection): void {
  if (selection.kind === 'state') {
    const state = doc.states[selection.index];
    doc.states.splice(selection.index, 1);
    doc.transitions = doc.transitions.filter((t) => (t.kind === 'loopback' ? t.state !== state.name : t.startState !== state.name && t.endState !== state.name));
  } else if (selection.kind === 'transition') {
    doc.transitions.splice(selection.index, 1);
  } else if (selection.kind === 'text') {
    if (doc.texts[selection.index].isGlobalTable) return; // matches Java's guard against deleting the global table
    doc.texts.splice(selection.index, 1);
  }
}

// Rounds a coordinate to the nearest multiple of `grid` (0 = no snapping).
export function snap(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}
