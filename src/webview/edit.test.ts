import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  colorIntToHex,
  createLoopback,
  createState,
  createText,
  createTransition,
  deletePage,
  deleteSelection,
  duplicateState,
  getAttrValue,
  getPriority,
  hexToColorInt,
  reconnectTransition,
  renameState,
  renameTransition,
  resizeState,
  setEquation,
  setPriority,
  snap,
  moveStateToPage,
  moveTextToPage,
  reconnectLoopback,
  newLocalAttribute,
  setResetState,
  setStateOutputValue,
  setTransitionOutputValue,
  getTransitionOutputValue,
  stateOutputAttributes,
  setTransitionStub,
} from './edit';
import { addOutput, addPriority } from './globals';
import { getBorderPts } from './geometry';
import { DEFAULT_PREFERENCES, FzmDocument, FzmLoopback, ObjAttribute } from '../fzm/model';

// Matches model.ts's private `attr()` helper: a global attribute with GLOBAL_VAR
// status on every field but name.
function globalAttr(name: string, value: string, visibility: number, type: string, nameStatus: string): ObjAttribute {
  return {
    name, nameStatus, value, valueStatus: 'GLOBAL_VAR',
    visibility, visibilityStatus: 'GLOBAL_VAR', type, typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page: -1,
  };
}

// A real Fizzim document always has at least the reserved state/trans
// "name"/"equation" global attributes (defaultDocument() seeds the same) -
// createState/createTransition/createLoopback seed new objects from these
// lists, so a doc without them isn't a realistic starting point.
function emptyDoc(): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [],
    stateAttrs: [globalAttr('name', 'def_name', 1, 'def_type', 'ABS')],
    transAttrs: [globalAttr('name', 'def_name', 0, 'def_type', 'ABS'), globalAttr('equation', '1', 1, 'def_type', 'ABS')],
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
}

function makeMachineAttr(name: string, value: string): ObjAttribute {
  return {
    name, nameStatus: 'ABS', value, valueStatus: 'LOCAL', visibility: 0, visibilityStatus: 'GLOBAL_VAR',
    type: '', typeStatus: 'GLOBAL_VAR', comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR', x2Obj: 0, y2Obj: 0, page: -1,
  };
}

test('createState names sequentially starting at state0', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 300, 100, 1);
  assert.equal(a.name, 'state0');
  assert.equal(b.name, 'state1');
  assert.equal(doc.states.length, 2);
});

test('createState continues numbering past existing names, not restarting at 0', () => {
  const doc = emptyDoc();
  createState(doc, 0, 0, 1); // state0
  createState(doc, 0, 0, 1); // state1
  const c = createState(doc, 0, 0, 1);
  assert.equal(c.name, 'state2');
});

test('createTransition and createLoopback both draw transN names from the same shared counter', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t1 = createTransition(doc, a, b, 1);
  const loop = createLoopback(doc, a, 0, 0, 1);
  assert.equal(t1.name, 'trans0');
  assert.equal(loop.name, 'trans1');
});

test('createText stores the given text at the click point', () => {
  const doc = emptyDoc();
  const txt = createText(doc, 50, 60, 1, 'hello world');
  assert.equal(txt.text, 'hello world');
  assert.equal(txt.x, 50);
  assert.equal(txt.y, 60);
  assert.equal(txt.isGlobalTable, false);
});

test('deleting a state cascades to delete its attached transition and loopback', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createTransition(doc, a, b, 1);
  createLoopback(doc, a, 0, 0, 1);
  assert.equal(doc.transitions.length, 2);

  deleteSelection(doc, { kind: 'state', index: 0 }); // delete state a

  assert.equal(doc.states.length, 1);
  assert.equal(doc.states[0].name, 'state1');
  assert.equal(doc.transitions.length, 0, 'both the transition and loopback attached to a should be gone');
});

test('deleting a state not involved in any transition leaves other transitions intact', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const c = createState(doc, 600, 0, 1);
  createTransition(doc, a, b, 1);

  deleteSelection(doc, { kind: 'state', index: 2 }); // delete c, uninvolved

  assert.equal(doc.states.length, 2);
  assert.equal(doc.transitions.length, 1);
});

test('deleting a transition removes only that transition', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createTransition(doc, a, b, 1);
  createLoopback(doc, a, 0, 0, 1);

  deleteSelection(doc, { kind: 'transition', index: 0 });

  assert.equal(doc.transitions.length, 1);
  assert.equal(doc.transitions[0].kind, 'loopback');
});

test('deleting the global-table text object is a no-op, matching the Java guard', () => {
  const doc = emptyDoc();
  doc.texts.push({ text: null, isGlobalTable: true, x: 10, y: 10, page: 1 });
  deleteSelection(doc, { kind: 'text', index: 0 });
  assert.equal(doc.texts.length, 1);
});

test('renameState cascades to transitions, loopbacks, and reset_state', () => {
  const doc = emptyDoc();
  doc.machine.push(makeMachineAttr('reset_state', 'state0'));
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createTransition(doc, a, b, 1); // state0 -> state1
  createLoopback(doc, a, 0, 0, 1); // loopback on state0

  const r = renameState(doc, 0, 'IDLE');
  assert.equal(r.ok, true);
  assert.equal(doc.states[0].name, 'IDLE');
  assert.equal(getAttrValue(doc.states[0].attributes, 'name'), 'IDLE');
  const normal = doc.transitions.find((t) => t.kind === 'transition')!;
  assert.equal(normal.kind === 'transition' && normal.startState, 'IDLE');
  const loop = doc.transitions.find((t) => t.kind === 'loopback')!;
  assert.equal(loop.kind === 'loopback' && loop.state, 'IDLE');
  assert.equal(doc.machine.find((m) => m.name === 'reset_state')?.value, 'IDLE');
});

test('renameState rejects a duplicate name and leaves the model unchanged', () => {
  const doc = emptyDoc();
  createState(doc, 0, 0, 1); // state0
  createState(doc, 300, 0, 1); // state1
  const r = renameState(doc, 1, 'state0');
  assert.equal(r.ok, false);
  assert.match(r.error!, /already exists/);
  assert.equal(doc.states[1].name, 'state1');
});

test('setResetState marks exactly one state and updates reset_state', () => {
  const doc = emptyDoc();
  doc.machine.push(makeMachineAttr('reset_state', ''));
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  a.reset = true; // pretend state0 was reset

  setResetState(doc, 1, true); // make state1 the reset state
  assert.equal(doc.states[0].reset, false);
  assert.equal(doc.states[1].reset, true);
  assert.equal(doc.machine.find((m) => m.name === 'reset_state')?.value, 'state1');
});

test('setEquation updates the transition equation attribute', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  assert.equal(getAttrValue(t.attributes, 'equation'), '1');
  setEquation(t, 'go && ready');
  assert.equal(getAttrValue(t.attributes, 'equation'), 'go && ready');
});

test('reconnectTransition rejects start === end and changes endpoints otherwise', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const c = createState(doc, 600, 0, 1);
  createTransition(doc, a, b, 1); // state0 -> state1

  const bad = reconnectTransition(doc, 0, 'state0', 'state0');
  assert.equal(bad.ok, false);

  const good = reconnectTransition(doc, 0, 'state0', 'state2');
  assert.equal(good.ok, true);
  const t = doc.transitions[0];
  assert.equal(t.kind === 'transition' && t.endState, 'state2');
});

test('renameTransition enforces uniqueness', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createTransition(doc, a, b, 1); // trans0
  createTransition(doc, b, a, 1); // trans1
  assert.equal(renameTransition(doc, 1, 'trans0').ok, false);
  assert.equal(renameTransition(doc, 1, 'go_back').ok, true);
  assert.equal(doc.transitions[1].name, 'go_back');
});

test('stateOutputAttributes lists a state\'s declared outputs', () => {
  const doc = emptyDoc();
  const s = createState(doc, 0, 0, 1);
  assert.equal(stateOutputAttributes(s).length, 0);
  addOutput(doc, 'reg'); // propagates a type="output" attr into every state
  const outs = stateOutputAttributes(s);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].type, 'output');
});

test('setStateOutputValue sets the value and marks it LOCAL, blank reverts to the output default (F3)', () => {
  const doc = emptyDoc();
  const s = createState(doc, 0, 0, 1);
  const out = addOutput(doc, 'reg'); // default "0"
  setStateOutputValue(s, out.name, '1', doc.stateAttrs);
  const attr = stateOutputAttributes(s)[0];
  assert.equal(attr.value, '1');
  assert.equal(attr.valueStatus, 'LOCAL');
  setStateOutputValue(s, out.name, '', doc.stateAttrs);
  assert.equal(attr.value, '0', 'blank must restore the output default, not go empty (an empty comb output errors in fizzim.pl)');
  assert.equal(attr.valueStatus, 'GLOBAL_VAR');
});

test('addOutput seeds per-state output values to the default (not empty)', () => {
  const doc = emptyDoc();
  const s = createState(doc, 0, 0, 1);
  addOutput(doc, 'comb'); // non-flag default is "0"
  assert.equal(stateOutputAttributes(s)[0].value, '0');
});

test('resizeState changes size keeping the top-left and reroutes transitions', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const t = createTransition(doc, a, b, 1);
  const before = t.kind === 'transition' ? { ...t.startPt } : { x: 0, y: 0 };
  const x0 = a.x0, y0 = a.y0;
  resizeState(doc, 0, 200, 80);
  assert.equal(a.x0, x0);
  assert.equal(a.y0, y0);
  assert.equal(a.x1 - a.x0, 200);
  assert.equal(a.y1 - a.y0, 80);
  assert.notDeepEqual(t.kind === 'transition' ? { ...t.startPt } : {}, before);
});

test('setTransitionOutputValue adds a type="output" attr on demand and removes it when cleared', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  addOutput(doc, 'comb'); // "out"

  assert.equal(getTransitionOutputValue(t, 'out'), '');
  setTransitionOutputValue(t, 'out', '1');
  assert.equal(getTransitionOutputValue(t, 'out'), '1');
  const attr = t.attributes.find((x) => x.name === 'out' && x.type === 'output');
  assert.ok(attr);
  assert.equal(attr!.valueStatus, 'LOCAL');

  setTransitionOutputValue(t, 'out', ''); // clear -> attribute removed
  assert.equal(getTransitionOutputValue(t, 'out'), '');
  assert.equal(t.attributes.some((x) => x.name === 'out' && x.type === 'output'), false);
});

test('hexToColorInt/colorIntToHex round-trip a color', () => {
  assert.equal(colorIntToHex(hexToColorInt('#ff8800')), '#ff8800');
  assert.equal(colorIntToHex(-16777216), '#000000'); // default black
});

test('getPriority/setPriority: set, get, and clear reverts to the declared global default (F4)', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  addPriority(doc); // declares "priority" globally, default "1000"

  // Set priority
  setPriority(t, '5', doc.transAttrs);
  assert.equal(getPriority(t), '5');
  const prioAttr = t.attributes.find((x) => x.name === 'priority');
  assert.ok(prioAttr);
  assert.equal(prioAttr!.type, ''); // not an output type
  assert.equal(prioAttr!.valueStatus, 'LOCAL');

  // Update priority
  setPriority(t, '10', doc.transAttrs);
  assert.equal(getPriority(t), '10');

  // Clear priority: reverts to the global default, the row survives (Java's
  // TPDelete refuses to delete a GLOBAL_FIXED row).
  setPriority(t, '', doc.transAttrs);
  assert.equal(getPriority(t), '1000');
  assert.equal(t.attributes.some((x) => x.name === 'priority'), true);
  assert.equal(prioAttr!.valueStatus, 'GLOBAL_VAR');
});


test('moveStateToPage moves the state, its attributes, and its loopbacks', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createTransition(doc, a, b, 1);
  createLoopback(doc, a, 0, 0, 1);
  moveStateToPage(doc, 0, 2);
  assert.equal(doc.states[0].page, 2);
  assert.equal(doc.states[0].attributes.every((at) => at.page === 2), true);
  const loop = doc.transitions.find((t) => t.kind === 'loopback')!;
  assert.equal(loop.page, 2);
});

test('newLocalAttribute is fully-editable (all LOCAL) and visible by default', () => {
  const a = newLocalAttribute('foo', 2);
  assert.equal(a.name, 'foo');
  assert.equal(a.nameStatus, 'LOCAL'); // makes it per-object deletable + name-editable
  assert.equal(a.valueStatus, 'LOCAL');
  assert.equal(a.visibility, 1);
  assert.equal(a.page, 2);
});

test('snap rounds to the nearest grid multiple, and does nothing when grid is 0', () => {
  assert.equal(snap(23, 25), 25);
  assert.equal(snap(12, 25), 0);
  assert.equal(snap(40, 25), 50);
  assert.equal(snap(5, 0), 5);
});

test('duplicateState adds a uniquely-named, offset copy that is not the reset state', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  a.reset = true;
  const copy = duplicateState(doc, 0);
  assert.equal(doc.states.length, 2);
  assert.notEqual(copy.name, a.name);
  assert.equal(copy.x0, a.x0 + 40);
  assert.equal(copy.reset, false);
  assert.equal(copy.attributes.find((x) => x.name === 'name')?.value, copy.name);
});

test('reconnectLoopback re-attaches a loopback to a different state', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const loop = createLoopback(doc, a, 100, 40, 1);
  assert.equal(loop.state, a.name);
  const r = reconnectLoopback(doc, doc.transitions.indexOf(loop), b.name);
  assert.equal(r.ok, true);
  assert.equal(loop.state, b.name);
  // geometry endpoints should now sit on state b's border (x near b's span)
  assert.ok(loop.startPt.x > 300, 'startPt should move to state b');
});

test('reconnectLoopback rejects an unknown state and a non-loopback', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const loop = createLoopback(doc, a, 100, 40, 1);
  assert.equal(reconnectLoopback(doc, doc.transitions.indexOf(loop), 'nope').ok, false);
  const t = createTransition(doc, a, b, 1);
  assert.equal(reconnectLoopback(doc, doc.transitions.indexOf(t), b.name).ok, false);
});

test('moveTextToPage moves free text but never the global table', () => {
  const doc = emptyDoc();
  const txt = createText(doc, 10, 10, 1, 'hi');
  moveTextToPage(doc, doc.texts.indexOf(txt), 2);
  assert.equal(txt.page, 2);
  // a global-table text is immovable
  doc.texts.push({ text: null, isGlobalTable: true, x: 10, y: 10, page: 1 });
  moveTextToPage(doc, doc.texts.length - 1, 2);
  assert.equal(doc.texts[doc.texts.length - 1].page, 1);
});

test('deletePage removes dangling cross-page transitions', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2');
  const a = createState(doc, 0, 0, 1);   // state0 on page 1
  const b = createState(doc, 300, 0, 1);  // state1 on page 1
  createTransition(doc, a, b, 1);         // trans0: state0 -> state1
  moveStateToPage(doc, 1, 2);             // move state1 to page 2
  // Now trans0 is cross-page (both endpoints on different pages)
  assert.equal(doc.transitions.length, 1);
  deletePage(doc, 2); // delete page 2 (state1's page)
  assert.equal(doc.states.length, 1, 'only state0 should remain');
  assert.equal(doc.states[0].name, 'state0');
  assert.equal(doc.transitions.length, 0, 'cross-page transition A->B should be gone');
  assert.equal(doc.tabs.length, 1);
});

// F18: the global table on the deleted page kept `page === pnum`, which
// after the page-shift is either another page's number (wrong page) or out
// of range (page no longer exists). Unlike DrawArea.removePage (which
// deletes the table outright), we keep it - it carries user positioning and
// our "Table" visibility toggle is a separate preference - but it must land
// somewhere valid.
test('deletePage reassigns the global table to page 1 instead of leaving it on an invalid page', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2', 'Page 3');
  const table = { text: null, isGlobalTable: true, x: 10, y: 10, page: 2 };
  doc.texts.push(table);
  deletePage(doc, 2); // the table's own page
  assert.equal(doc.tabs.length, 2);
  assert.equal(table.page, 1, 'the table must land on a page that still exists');
  assert.ok(doc.texts.includes(table), 'the table itself is kept, unlike Java');
});

test('deletePage leaves the global table alone when its page is unaffected', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2', 'Page 3');
  const table = { text: null, isGlobalTable: true, x: 10, y: 10, page: 3 };
  doc.texts.push(table);
  deletePage(doc, 1); // an earlier page - page 3 shifts down to page 2
  assert.equal(table.page, 2, 'a table on a surviving page just renumbers normally');
});

test('deletePage renumbers attribute pages', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2');
  doc.tabs.push('Page 3');
  const c = createState(doc, 0, 0, 1);   // state0 on page 1
  moveStateToPage(doc, 0, 3);             // move to page 3
  // state0 and its attributes are now on page 3
  assert.equal(c.page, 3);
  assert.equal(c.attributes.every((a) => a.page === 3), true);
  deletePage(doc, 2); // delete page 2 (empty page between 1 and 3)
  assert.equal(c.page, 2, 'state should shift from page 3 to page 2');
  assert.equal(c.attributes.every((a) => a.page === 2), true, 'attribute pages should also shift');
});

test('deletePage removes loopbacks on the deleted page', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2');
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  createLoopback(doc, a, 0, 0, 1);        // loopback on state0, page 1
  createLoopback(doc, b, 0, 0, 1);        // loopback on state1, page 1
  moveStateToPage(doc, 1, 2);             // move state1 to page 2
  // state1's loopback should also be on page 2 (moveStateToPage handles it)
  const loopOnPage2 = doc.transitions.find((t) => t.kind === 'loopback' && t.page === 2)!;
  assert.ok(loopOnPage2, 'state1\'s loopback should be on page 2');
  deletePage(doc, 2);
  assert.equal(doc.transitions.filter((t) => t.kind === 'loopback').length, 1, 'only state0\'s loopback remains');
  const remaining = doc.transitions[0] as FzmLoopback;
  assert.equal(remaining.kind, 'loopback');
  assert.equal(remaining.state, 'state0');
});

test('createTransition seeds cross-page connector geometry when the two states already live on different pages (regression: used to draw into the canvas origin)', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  moveStateToPage(doc, 1, 2); // b now lives on page 2, before any transition connects them
  const t = createTransition(doc, a, b, 1);

  // The old bug: startPt/endPt/control points stayed at their zero-initialized
  // (0,0), since only recomputeTransition (the same-page branch) ever ran.
  // A cross-page connector docks pageS/pageE to the page edges instead.
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50, 'source connector docks to the page edge');
  assert.equal(t.pageE.x, 50, 'dest connector docks to the page edge');
  assert.notDeepEqual(t.startPt, { x: 0, y: 0 }, 'startPt should be seeded on the border, not left at the origin');
});

test('createTransition gives every point its own object (regression: all 8 points used to alias the same {0,0})', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  t.startPt.x = 999;
  assert.notEqual(t.endPt.x, 999, 'mutating one point must not affect another');
  assert.notEqual(t.startCtrlPt.x, 999);
  assert.notEqual(t.pageS.x, 999);
});

// F10: adding/removing/flipping a cross-page sibling shifts the whole
// stagger group sharing an endpoint (getOffset's offset is a rank-out-of-
// total, so it must be re-run for every sibling, not just the one that
// changed). These regression tests target the specific call sites that used
// to leave that group stale: createTransition (a genuinely NEW sibling was
// already restaggering only itself), deleteSelection, deletePage, and
// moveStateToPage (a transition flipping same-page <-> cross-page due to its
// OWN endpoint moving must also refresh siblings that don't touch that state
// at all).

test('createTransition re-staggers existing cross-page siblings when a new one joins (F10)', () => {
  // getOffset's stagger is (rank - average) * 40 - with only 1 or 2 siblings
  // the first-created one always lands at offset 0 regardless, so this needs
  // a 3rd sibling to show rank 1's offset actually shift (0 -> -40).
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 2);
  const c = createState(doc, 300, 200, 2);
  const d = createState(doc, 300, 400, 2);
  const t1 = createTransition(doc, a, b, 1); // rank 1 of 1, offset 0
  createTransition(doc, a, c, 1); // rank 2 of 2, offset 0 too - still no visible change
  const before = t1.pageS.y;
  createTransition(doc, a, d, 1); // rank 3 of 3 - now t1's offset must shift to -40
  assert.notEqual(t1.pageS.y, before, 't1 must re-stagger once A has two more cross-page siblings');
});

test('deleteSelection re-staggers surviving cross-page siblings after one is deleted (F10)', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 2);
  const c = createState(doc, 300, 200, 2);
  const d = createState(doc, 300, 400, 2);
  const t1 = createTransition(doc, a, b, 1); // rank 1 of 3, offset -40
  const t2 = createTransition(doc, a, c, 1); // rank 2 of 3, offset 0
  createTransition(doc, a, d, 1); // rank 3 of 3, offset 40
  const t1Before = t1.pageS.y;

  deleteSelection(doc, { kind: 'transition', index: doc.transitions.indexOf(t2) });

  assert.equal(doc.transitions.length, 2);
  assert.notEqual(t1.pageS.y, t1Before, 't1 must re-stagger once only 2 of the original 3 siblings remain');
});

test('deletePage re-staggers surviving cross-page siblings after a sibling\'s page is deleted (F10)', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2', 'Page 3', 'Page 4'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 2);
  const c = createState(doc, 300, 200, 3);
  const d = createState(doc, 300, 400, 4);
  const t1 = createTransition(doc, a, b, 1); // rank 1 of 3, offset -40
  createTransition(doc, a, c, 1); // rank 2 of 3, offset 0 - lives on page 3
  createTransition(doc, a, d, 1); // rank 3 of 3, offset 40
  const t1Before = t1.pageS.y;

  deletePage(doc, 3); // removes state c and its transition to A

  assert.equal(doc.transitions.length, 2);
  assert.notEqual(t1.pageS.y, t1Before, 't1 must re-stagger once only 2 of the original 3 siblings remain');
});

test('moveStateToPage re-staggers cross-page siblings sharing the far endpoint, even ones that don\'t touch the moved state (F10)', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const w = createState(doc, 0, 0, 1);
  const z = createState(doc, 0, 200, 1);
  const b = createState(doc, 300, 0, 2);
  const y = createState(doc, 300, 400, 2); // starts on the SAME page as b

  const wb = createTransition(doc, w, b, 1); // cross-page from creation: rank 1 of 2, offset 0
  createTransition(doc, z, b, 1); // rank 2 of 2, offset 40 - neither touches y
  createTransition(doc, y, b, 2); // same-page as b for now (y hasn't moved yet)
  // w->b and z->b share B as their ENDSTATE, so their stagger lives on the
  // "end" side (pageE/eOffset) - the "start" side (pageS) staggers by each
  // transition's own startState (w and z are each unique, so pageS never
  // moves here; that would be the wrong field to assert on).
  const wbBefore = wb.pageE.y;

  // y moves off b's page: its own transition flips to cross-page, growing b's
  // sibling group from 2 to 3 - wb doesn't touch y at all, but must still
  // re-stagger since the group it belongs to just grew.
  moveStateToPage(doc, doc.states.indexOf(y), 1);

  assert.notEqual(wb.pageE.y, wbBefore, "wb must re-stagger once b's group grows from 2 to 3, even though wb never touches y");
});

test('reconnectTransition seeds cross-page geometry and re-pages the transition when the new endpoint is on another page', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const c = createState(doc, 0, 0, 1);
  moveStateToPage(doc, 2, 2); // c now lives on page 2
  const t = createTransition(doc, a, b, 1); // same-page a -> b

  const r = reconnectTransition(doc, doc.transitions.indexOf(t), 'state0', 'state2');
  assert.equal(r.ok, true);
  assert.equal(t.page, 1, "a transition's own page tracks its start state's page");
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50, 'reconnecting across pages docks the connector');
});

// F16: reconnectTransition never checked t.stub at all, so reconnecting a
// stub to a different start state left its tip (pageS) pointing at wherever
// the OLD start state used to be - the property dialog's own follow-up
// setTransitionStub call is a no-op here since t.stub doesn't change, so
// there was no way to repair it from the UI.
test('reconnectTransition re-seeds stub geometry on the new start state, not the old one', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const c = createState(doc, 600, 300, 1); // the new start state, elsewhere on the page
  const t = createTransition(doc, a, b, 1);
  if (t.kind !== 'transition') throw new Error('expected a normal transition');
  setTransitionStub(doc, t, true);
  const oldStartPt = { ...t.startPt };

  const r = reconnectTransition(doc, doc.transitions.indexOf(t), 'state2', 'state1');
  assert.equal(r.ok, true);
  assert.equal(t.stub, true, 'still a stub after reconnecting');
  assert.notDeepEqual(t.startPt, oldStartPt, "the anchor must move onto the new start state, not stay at the old one's border point");
  assert.equal(t.startStateIndex, 0, 'seeded at border point 0, like a freshly-stubbed transition');
  assert.equal(t.pageS.x, t.startPt.x + 60, 'tip re-seeded 60px to the right of the new anchor');
});

// Properties dialog OK calls reconnectTransition unconditionally with the
// dropdowns' current values, even when the user only edited an unrelated
// field (equation, priority, ...). Without a no-op guard this silently
// re-seeded a stub's hand-dragged tip - or an ordinary transition's
// hand-dragged curve - back to its default geometry on every such edit.
test('reconnectTransition with unchanged start/end leaves a hand-dragged stub tip untouched', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  if (t.kind !== 'transition') throw new Error('expected a normal transition');
  setTransitionStub(doc, t, true);
  t.pageS = { x: 12345, y: 6789 }; // simulate the user having dragged the tip elsewhere
  const draggedPt = { ...t.pageS };

  const r = reconnectTransition(doc, doc.transitions.indexOf(t), t.startState, t.endState);
  assert.equal(r.ok, true);
  assert.deepEqual(t.pageS, draggedPt, 'a no-op reconnect must not reseed the stub tip back to its default');
});

test('reconnectTransition with unchanged start/end leaves a hand-dragged curve untouched', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  if (t.kind !== 'transition') throw new Error('expected a normal transition');
  t.startCtrlPt = { x: 111, y: 222 }; // simulate the user having dragged the curve
  t.endCtrlPt = { x: 333, y: 444 };
  const draggedStart = { ...t.startCtrlPt };
  const draggedEnd = { ...t.endCtrlPt };

  const r = reconnectTransition(doc, doc.transitions.indexOf(t), t.startState, t.endState);
  assert.equal(r.ok, true);
  assert.deepEqual(t.startCtrlPt, draggedStart, 'a no-op reconnect must not recompute the curve control points');
  assert.deepEqual(t.endCtrlPt, draggedEnd, 'a no-op reconnect must not recompute the curve control points');
});

test("moveStateToPage keeps a normal transition's page tracking its start state's page", () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  assert.equal(t.page, 1);

  moveStateToPage(doc, 0, 2); // move the START state -> the transition's own page follows
  assert.equal(t.page, 2, "transition.page should track its (possibly moved) start state");
});

test('moveStateToPage moves every attribute label onto the start page when a transition first becomes cross-page', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  assert.equal(t.attributes.every((attr) => attr.page === 1), true, 'starts out all on the shared page');

  moveStateToPage(doc, 1, 2); // b -> page 2: t is now cross-page for the first time
  assert.equal(t.attributes.every((attr) => attr.page === 1), true, 'labels pile onto the (new) start page, like Java');
});

test('moveStateToPage re-seeds a transition that just became cross-page, and restores it when moved back', () => {
  const doc = emptyDoc();
  doc.tabs = ['Page 1', 'Page 2'];
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);

  moveStateToPage(doc, 1, 2); // B -> page 2, so A->B is now cross-page
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50, 'connector docks to the page edge');
  assert.equal(t.pageE.x, 50);

  moveStateToPage(doc, 1, 1); // B back to page 1 -> normal transition again
  assert.deepEqual(t.startPt, getBorderPts(doc.states[0])[t.startStateIndex], 'recomputeTransition ran');
});
