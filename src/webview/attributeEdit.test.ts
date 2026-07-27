import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  applyAttributeEdits,
  attrCellEditable,
  attrColValue,
  AttrRowEdit,
  createState,
  createTransition,
  reconcileTransitionOutputs,
  setTransitionStub,
  transitionDialogAttributes,
} from './edit';
import { addOutput } from './globals';
import { DEFAULT_PREFERENCES, FzmDocument, ObjAttribute } from '../fzm/model';

// A real Fizzim document always has at least the reserved state/trans
// "name"/"equation" global attributes (defaultDocument() seeds the same) -
// createState/createTransition seed new objects from these lists, so a doc
// without them isn't a realistic starting point.
function emptyDoc(): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [],
    stateAttrs: [attr({ name: 'name', nameStatus: 'ABS', value: 'def_name', visibility: 1, type: 'def_type' })],
    transAttrs: [
      attr({ name: 'name', nameStatus: 'ABS', value: 'def_name', visibility: 0, type: 'def_type' }),
      attr({ name: 'equation', nameStatus: 'ABS', value: '1', visibility: 1, type: 'def_type' }),
    ],
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
}

function attr(over: Partial<ObjAttribute>): ObjAttribute {
  return {
    name: 'a', nameStatus: 'GLOBAL_VAR', value: '', valueStatus: 'GLOBAL_VAR',
    visibility: 0, visibilityStatus: 'GLOBAL_VAR', type: '', typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page: 1, ...over,
  };
}

function fullEdit(a: ObjAttribute, over: Partial<AttrRowEdit> = {}): AttrRowEdit {
  return {
    value: a.value, visibility: a.visibility, type: a.type,
    comment: a.comment, color: a.color, useratts: a.useratts, resetval: a.resetval, ...over,
  };
}

test('attrCellEditable: GLOBAL_VAR/LOCAL editable, ABS/GLOBAL_FIXED locked', () => {
  const a = attr({ nameStatus: 'ABS', valueStatus: 'LOCAL', typeStatus: 'GLOBAL_FIXED', commentStatus: 'GLOBAL_VAR' });
  assert.equal(attrCellEditable(a, 0), false, 'name ABS -> locked');
  assert.equal(attrCellEditable(a, 1), true, 'value LOCAL -> editable');
  assert.equal(attrCellEditable(a, 3), false, 'type GLOBAL_FIXED -> locked (globals-only)');
  assert.equal(attrCellEditable(a, 4), true, 'comment GLOBAL_VAR -> editable');
});

test('attrColValue reads the right field per column (numbers for vis & color)', () => {
  const a = attr({ name: 'x', value: 'v', visibility: 2, type: 'reg', comment: 'c', color: -1, useratts: 'u', resetval: 'r' });
  assert.equal(attrColValue(a, 0), 'x');
  assert.equal(attrColValue(a, 1), 'v');
  assert.equal(attrColValue(a, 2), 2);
  assert.equal(attrColValue(a, 3), 'reg');
  assert.equal(attrColValue(a, 4), 'c');
  assert.equal(attrColValue(a, 5), -1);
  assert.equal(attrColValue(a, 6), 'u');
  assert.equal(attrColValue(a, 7), 'r');
});

test('applyAttributeEdits writes editable columns and marks changed ones LOCAL when they differ from the global default', () => {
  const globalDefault = attr({ name: 'foo', value: 'def', visibility: 1 });
  const a = attr({ name: 'foo', value: 'def', valueStatus: 'GLOBAL_VAR', visibility: 1, visibilityStatus: 'GLOBAL_VAR' });
  applyAttributeEdits([a], [fullEdit(a, { value: 'override' })], [globalDefault]);
  assert.equal(a.value, 'override');
  assert.equal(a.valueStatus, 'LOCAL', 'differs from default -> LOCAL');
  assert.equal(a.visibility, 1, 'unchanged column untouched');
});

test('applyAttributeEdits marks a column GLOBAL_VAR when the new value matches the global default', () => {
  const globalDefault = attr({ name: 'foo', value: 'def' });
  const a = attr({ name: 'foo', value: 'other', valueStatus: 'LOCAL' });
  applyAttributeEdits([a], [fullEdit(a, { value: 'def' })], [globalDefault]);
  assert.equal(a.value, 'def');
  assert.equal(a.valueStatus, 'GLOBAL_VAR', 'now matches default -> GLOBAL_VAR');
});

test('applyAttributeEdits never mutates a locked cell', () => {
  const a = attr({ name: 'foo', value: 'keep', valueStatus: 'GLOBAL_FIXED' });
  applyAttributeEdits([a], [fullEdit(a, { value: 'nope' })], []);
  assert.equal(a.value, 'keep', 'GLOBAL_FIXED value must not change from a local dialog');
  assert.equal(a.valueStatus, 'GLOBAL_FIXED');
});

test('applyAttributeEdits: clearing the Value column reverts to the global default value', () => {
  const globalDefault = attr({ name: 'out0', value: '3' });
  const a = attr({ name: 'out0', value: '7', valueStatus: 'LOCAL', type: 'output' });
  applyAttributeEdits([a], [fullEdit(a, { value: '' })], [globalDefault]);
  assert.equal(a.value, '3', 'blank reverts to the default');
  assert.equal(a.valueStatus, 'GLOBAL_VAR');
});

// F11: Java's restore-on-empty is `col != 2 && value.equals("")` - any
// column, not just Value - and GeneralObj.java:129-130 explicitly restores a
// blank Type too. Blanking a transition output row's Type used to set
// type = '' permanently (typeStatus LOCAL), which then survived every future
// reconcile - fizzim.pl's `{type} eq "output"` filter misses it and that
// transition's output assignment silently vanishes from the HDL.
test('applyAttributeEdits: clearing the Type column reverts to the global default type (F11)', () => {
  const globalDefault = attr({ name: 'out0', type: 'output', typeStatus: 'GLOBAL_VAR' });
  const a = attr({ name: 'out0', value: '1', type: 'output', typeStatus: 'GLOBAL_VAR' });
  applyAttributeEdits([a], [fullEdit(a, { type: '' })], [globalDefault]);
  assert.equal(a.type, 'output', 'blank reverts to the default type, not "" ');
  assert.equal(a.typeStatus, 'GLOBAL_VAR');
});

test('transitionDialogAttributes adds a placeholder row for each declared output not yet on the transition', () => {
  const doc = emptyDoc();
  const s0 = createState(doc, 0, 0, 1);
  const s1 = createState(doc, 300, 0, 1);
  const t = createTransition(doc, s0, s1, 1);
  const out = addOutput(doc, 'comb');
  const rows = transitionDialogAttributes(t, doc.outputs);
  assert.ok(rows.some((a) => a.name === 'name'), 'keeps the name attribute');
  assert.ok(rows.some((a) => a.name === 'equation'), 'keeps the equation attribute');
  const outRow = rows.find((a) => a.name === out.name && a.type === 'output');
  assert.ok(outRow, 'adds a placeholder for the output');
  assert.equal(outRow!.value, '', 'placeholder starts blank');
  assert.equal(t.attributes.some((a) => a.name === out.name), false, 'the placeholder is NOT yet stored on the transition');
});

test('reconcileTransitionOutputs stores non-empty output rows and drops empty ones', () => {
  const doc = emptyDoc();
  const s0 = createState(doc, 0, 0, 1);
  const s1 = createState(doc, 300, 0, 1);
  const t = createTransition(doc, s0, s1, 1);
  const out = addOutput(doc, 'comb');
  const rows = transitionDialogAttributes(t, doc.outputs);
  const outRow = rows.find((a) => a.name === out.name)!;
  outRow.value = '1'; // user set the Mealy output
  reconcileTransitionOutputs(t, rows);
  assert.equal(t.attributes.filter((a) => a.name === out.name && a.type === 'output').length, 1, 'output now stored on the transition');
  // Now clear it and reconcile again -> removed.
  const rows2 = transitionDialogAttributes(t, doc.outputs);
  rows2.find((a) => a.name === out.name)!.value = '';
  reconcileTransitionOutputs(t, rows2);
  assert.equal(t.attributes.some((a) => a.name === out.name), false, 'clearing removes the output attribute');
});

test('setTransitionStub toggles the stub flag and seeds/tears down its geometry', () => {
  const doc = emptyDoc();
  const s0 = createState(doc, 0, 0, 1);
  const s1 = createState(doc, 300, 0, 1);
  const t = createTransition(doc, s0, s1, 1);
  if (t.kind !== 'transition') throw new Error('expected a normal transition');
  assert.equal(t.stub, false);

  setTransitionStub(doc, t, true);
  assert.equal(t.stub, true);
  // Seeded at border point 0 with the tip 60px to its right.
  assert.equal(t.startStateIndex, 0);
  assert.equal(t.pageS.x, t.startPt.x + 60);
  assert.equal(t.pageS.y, t.startPt.y);

  setTransitionStub(doc, t, false);
  assert.equal(t.stub, false);
});

// F8: untick Stub? on a genuinely cross-page transition (ticking Stub? seeds
// local geometry from the start state's own border, ignoring page-ness) - the
// off-branch used to call recomputeTransition() unconditionally, with no
// cross-page check, silently computing a same-page curve for endpoints that
// aren't on the same page. The connector collapsed on top of the state with
// no way to repair it from the UI otherwise (recomputeCrossPage is only
// reachable again via moveStateToPage/reconnectTransition).
test('setTransitionStub off re-docks a cross-page transition via recomputeCrossPage, not a same-page curve', () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2');
  const s0 = createState(doc, 0, 0, 1);
  const s1 = createState(doc, 300, 0, 2); // different page - genuinely cross-page
  const t = createTransition(doc, s0, s1, 1);
  if (t.kind !== 'transition') throw new Error('expected a normal transition');

  setTransitionStub(doc, t, true);
  assert.equal(t.stub, true);

  setTransitionStub(doc, t, false);
  assert.equal(t.stub, false);
  // recomputeCrossPage's signature: startCtrlPt sits exactly 20px right of
  // startPt (geometry.ts), which a same-page recomputeTransition would not
  // produce (its control points come from trig on the states' relative angle).
  assert.equal(t.startCtrlPt.x, t.startPt.x + 20);
  assert.equal(t.startCtrlPt.y, t.startPt.y);
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50);
});

test('applyAttributeEdits renames a LOCAL attribute', () => {
  const a = attr({ name: 'mine', nameStatus: 'LOCAL' });
  applyAttributeEdits([a], [fullEdit(a, { name: 'renamed' })], []);
  assert.equal(a.name, 'renamed');
});

test('applyAttributeEdits ignores a rename that collides with another attribute on the object', () => {
  const a = attr({ name: 'mine', nameStatus: 'LOCAL' });
  const b = attr({ name: 'taken', nameStatus: 'LOCAL' });
  applyAttributeEdits([a, b], [fullEdit(a, { name: 'taken' }), fullEdit(b)], []);
  assert.equal(a.name, 'mine', 'duplicate name ignored');
});

test('applyAttributeEdits ignores a rename on a non-LOCAL attribute, and an empty name', () => {
  const g = attr({ name: 'global', nameStatus: 'GLOBAL_FIXED' });
  applyAttributeEdits([g], [fullEdit(g, { name: 'nope' })], []);
  assert.equal(g.name, 'global', 'GLOBAL_FIXED name is not renameable');
  const l = attr({ name: 'mine', nameStatus: 'LOCAL' });
  applyAttributeEdits([l], [fullEdit(l, { name: '' })], []);
  assert.equal(l.name, 'mine', 'empty name ignored');
});
