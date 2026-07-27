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
} from './edit';
import { addOutput } from './globals';
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

test('setStateOutputValue sets the value and marks it LOCAL, blank reverts to GLOBAL_VAR', () => {
  const doc = emptyDoc();
  const s = createState(doc, 0, 0, 1);
  const out = addOutput(doc, 'reg');
  setStateOutputValue(s, out.name, '1');
  const attr = stateOutputAttributes(s)[0];
  assert.equal(attr.value, '1');
  assert.equal(attr.valueStatus, 'LOCAL');
  setStateOutputValue(s, out.name, '');
  assert.equal(attr.value, '');
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

test('getPriority/setPriority: set, get, and clear removes the attribute', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);

  // Initially no priority
  assert.equal(getPriority(t), '');
  assert.equal(t.attributes.some((x) => x.name === 'priority'), false);

  // Set priority
  setPriority(t, '5');
  assert.equal(getPriority(t), '5');
  const prioAttr = t.attributes.find((x) => x.name === 'priority');
  assert.ok(prioAttr);
  assert.equal(prioAttr!.type, ''); // not an output type
  assert.equal(prioAttr!.valueStatus, 'LOCAL');

  // Update priority
  setPriority(t, '10');
  assert.equal(getPriority(t), '10');

  // Clear priority (empty string removes the attribute)
  setPriority(t, '');
  assert.equal(getPriority(t), '');
  assert.equal(t.attributes.some((x) => x.name === 'priority'), false);
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
