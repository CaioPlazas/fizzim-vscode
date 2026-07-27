import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addGraycode, addInput, addOutput, addPriority, addReset, addUserAttribute, deleteGlobalAttr, globalList, hasReset, hasTransAttr, MACHINE, OUTPUTS, reconcileGlobals, renameGlobalAttr, setGlobalAttrField, STATE_ATTRS, TRANS_ATTRS, validateOutputEdit } from './globals';
import { createLoopback, createState, createTransition, sanitizeLocalOutputTypes } from './edit';
import { DEFAULT_PREFERENCES, defaultDocument, FzmDocument, ObjAttribute } from '../fzm/model';

function docWithStates(names: string[]): FzmDocument {
  const doc: FzmDocument = {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [], stateAttrs: [], transAttrs: [],
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
  for (const _ of names) createState(doc, 0, 0, 1);
  doc.states.forEach((s, i) => (s.name = names[i]));
  return doc;
}

function hasAttr(list: ObjAttribute[], name: string): boolean {
  return list.some((a) => a.name === name);
}

test('addPriority adds a single global+per-transition priority (default 1000), idempotent', () => {
  const doc = docWithStates(['A', 'B']);
  const t = createTransition(doc, doc.states[0], doc.states[1], 1);
  assert.equal(addPriority(doc), true);
  assert.equal(hasTransAttr(doc, 'priority'), true);
  assert.equal(doc.transAttrs.filter((a) => a.name === 'priority').length, 1);
  const p = t.attributes.find((a) => a.name === 'priority');
  assert.equal(p?.value, '1000');
  assert.equal(p?.visibility, 1);
  // second add is a no-op (Fizzim disables the button once it exists)
  assert.equal(addPriority(doc), false);
  assert.equal(t.attributes.filter((a) => a.name === 'priority').length, 1);
});

// Regression: a transition/loopback created via createTransition/createLoopback
// used to be seeded with only a hardcoded name+equation, ignoring whatever the
// global transAttrs list already declared (priority, graycode, custom attrs) -
// so a transition drawn after "Add Priority" was clicked silently had no
// priority row until Global Attributes was reopened (which runs a full
// reconcile and mirrors it in retroactively). createTransition/createLoopback
// now seed straight from doc.transAttrs (Java's `trans.updateAttrib(globalList,
// 4)`, called right after construction), so this must show up immediately.
test('a transition/loopback created after priority+graycode were declared is seeded with them immediately', () => {
  const doc = docWithStates(['A', 'B']);
  assert.equal(addPriority(doc), true);
  assert.equal(addGraycode(doc), true);

  const t = createTransition(doc, doc.states[0], doc.states[1], 1);
  assert.equal(t.attributes.find((a) => a.name === 'priority')?.value, '1000');
  assert.equal(t.attributes.find((a) => a.name === 'graycode')?.value, '');

  const lp = createLoopback(doc, doc.states[0], 0, 0, 1);
  assert.equal(lp.attributes.find((a) => a.name === 'priority')?.value, '1000');
  assert.equal(lp.attributes.find((a) => a.name === 'graycode')?.value, '');
});

// Same defect class for states: a state created after an output was already
// declared used to be seeded with only its name, missing the output entirely
// until the next Global Attributes reconcile.
test('a state created after an output was already declared is seeded with it immediately', () => {
  const doc = docWithStates([]);
  const out = addOutput(doc, 'reg');
  const s = createState(doc, 0, 0, 1);
  const o = s.attributes.find((a) => a.name === out.name && a.type === 'output');
  assert.ok(o, 'new state carries the already-declared output');
  assert.equal(o!.value, out.value, 'seeded at the output\'s current default');
});

test('addGraycode adds a single global graycode attribute, idempotent', () => {
  const doc = docWithStates(['A', 'B']);
  createTransition(doc, doc.states[0], doc.states[1], 1);
  assert.equal(addGraycode(doc), true);
  assert.equal(hasTransAttr(doc, 'graycode'), true);
  assert.equal(addGraycode(doc), false);
  assert.equal(doc.transAttrs.filter((a) => a.name === 'graycode').length, 1);
});

test('addInput appends a uniquely named input', () => {
  const doc = docWithStates([]);
  const a = addInput(doc);
  const b = addInput(doc);
  assert.equal(a.name, 'in');
  assert.equal(b.name, 'in1');
  assert.equal(doc.inputs.length, 2);
});

test('addOutput propagates a type="output" attribute to the states global list and every state', () => {
  const doc = docWithStates(['IDLE', 'READ']);
  const out = addOutput(doc, 'reg');
  assert.equal(out.type, 'reg');
  assert.ok(hasAttr(doc.outputs, out.name));
  // states global list gets a matching type="output" attr
  const stateGlobal = doc.stateAttrs.find((a) => a.name === out.name);
  assert.ok(stateGlobal, 'states global list should contain the output');
  assert.equal(stateGlobal!.type, 'output');
  // every state gets it too
  for (const s of doc.states) {
    const a = s.attributes.find((x) => x.name === out.name);
    assert.ok(a, `state ${s.name} should have the output attribute`);
    assert.equal(a!.type, 'output');
  }
});

test('renaming an output cascades to the states global list and every state', () => {
  const doc = docWithStates(['IDLE', 'READ']);
  const out = addOutput(doc, 'comb');
  const oldName = out.name; // capture before the rename mutates the object
  const idx = doc.outputs.findIndex((a) => a.name === oldName);
  const r = renameGlobalAttr(doc, OUTPUTS, idx, 'ds');
  assert.equal(r.ok, true);
  assert.ok(hasAttr(doc.outputs, 'ds'));
  assert.ok(hasAttr(doc.stateAttrs, 'ds'));
  for (const s of doc.states) assert.ok(hasAttr(s.attributes, 'ds'));
  // old name gone everywhere
  assert.ok(!hasAttr(doc.stateAttrs, oldName));
});

test('deleting an output removes it from the states global list and every state', () => {
  const doc = docWithStates(['IDLE', 'READ']);
  const out = addOutput(doc, 'reg');
  const idx = doc.outputs.findIndex((a) => a.name === out.name);
  deleteGlobalAttr(doc, OUTPUTS, idx);
  assert.ok(!hasAttr(doc.outputs, out.name));
  assert.ok(!hasAttr(doc.stateAttrs, out.name));
  for (const s of doc.states) assert.ok(!hasAttr(s.attributes, out.name));
});

test('addReset adds reset_signal and reset_state pointing at the first state, idempotently', () => {
  const doc = docWithStates(['IDLE', 'READ']);
  addReset(doc);
  addReset(doc); // second call should not duplicate
  assert.equal(doc.machine.filter((a) => a.name === 'reset_signal').length, 1);
  const rs = doc.machine.find((a) => a.name === 'reset_state');
  assert.ok(rs);
  assert.equal(rs!.value, 'IDLE');
});

test('protected (ABS) attributes cannot be renamed or deleted', () => {
  const doc = docWithStates([]);
  addReset(doc); // reset_signal/reset_state are ABS
  const idx = doc.machine.findIndex((a) => a.name === 'reset_signal');
  const r = renameGlobalAttr(doc, 0, idx, 'foo');
  assert.equal(r.ok, false);
  const before = doc.machine.length;
  deleteGlobalAttr(doc, 0, idx);
  assert.equal(doc.machine.length, before);
});

test('addUserAttribute on States propagates to every state; rename + delete cascade', () => {
  const doc = docWithStates(['A', 'B']);
  const attr = addUserAttribute(doc, STATE_ATTRS);
  assert.ok(hasAttr(doc.stateAttrs, attr.name));
  for (const s of doc.states) assert.ok(hasAttr(s.attributes, attr.name));

  const idx = doc.stateAttrs.findIndex((a) => a.name === attr.name);
  assert.equal(renameGlobalAttr(doc, STATE_ATTRS, idx, 'count').ok, true);
  for (const s of doc.states) assert.ok(hasAttr(s.attributes, 'count'));

  deleteGlobalAttr(doc, STATE_ATTRS, doc.stateAttrs.findIndex((a) => a.name === 'count'));
  for (const s of doc.states) assert.ok(!hasAttr(s.attributes, 'count'));
});

test('addUserAttribute on Transitions propagates to every transition', () => {
  const doc = docWithStates(['A', 'B']);
  createTransition(doc, doc.states[0], doc.states[1], 1);
  const attr = addUserAttribute(doc, TRANS_ATTRS);
  for (const t of doc.transitions) assert.ok(hasAttr(t.attributes, attr.name));
});

test('addUserAttribute on Machine is machine-only (no per-object propagation)', () => {
  const doc = docWithStates(['A']);
  const attr = addUserAttribute(doc, MACHINE);
  assert.ok(hasAttr(doc.machine, attr.name));
  assert.ok(!hasAttr(doc.states[0].attributes, attr.name));
});

test('an output shown in the States list cannot be deleted from there', () => {
  const doc = docWithStates(['A']);
  const out = addOutput(doc, 'reg');
  const idx = doc.stateAttrs.findIndex((a) => a.name === out.name && a.type === 'output');
  deleteGlobalAttr(doc, STATE_ATTRS, idx); // should be a no-op
  assert.ok(hasAttr(doc.stateAttrs, out.name));
  assert.ok(hasAttr(doc.states[0].attributes, out.name));
});

// --- reconcileGlobals (GeneralObj.updateAttrib port) ----------------------
// These need a realistic global baseline (the `name`/`equation` ABS globals a
// real doc always carries) so each object's attributes line up by index with
// the global lists — reconcile is index-based, like Java's updateAttrib.

function reconcileDoc(names: string[]): FzmDocument {
  const doc = defaultDocument();
  for (const _ of names) createState(doc, 0, 0, 1);
  doc.states.forEach((s, i) => {
    s.name = names[i];
    const nameAttr = s.attributes.find((a) => a.name === 'name');
    if (nameAttr) nameAttr.value = names[i];
  });
  return doc;
}

function stateOutput(doc: FzmDocument, stateName: string, outName: string): ObjAttribute | undefined {
  return doc.states.find((s) => s.name === stateName)?.attributes.find((a) => a.name === outName && a.type === 'output');
}

test('reconcile: changing an output default propagates to every non-overridden state', () => {
  const doc = reconcileDoc(['A', 'B']);
  const out = addOutput(doc, 'reg'); // default "0", seeded into both states
  assert.equal(stateOutput(doc, 'A', out.name)?.value, '0');
  // User edits the output's default in the Outputs tab.
  setGlobalAttrField(out, 'value', '1');
  reconcileGlobals(doc);
  assert.equal(stateOutput(doc, 'A', out.name)?.value, '1');
  assert.equal(stateOutput(doc, 'B', out.name)?.value, '1');
});

test('reconcile: a per-state LOCAL override survives a default change', () => {
  const doc = reconcileDoc(['A', 'B']);
  const out = addOutput(doc, 'reg');
  // State A overrides the output locally.
  const a = stateOutput(doc, 'A', out.name)!;
  a.value = '1';
  a.valueStatus = 'LOCAL';
  setGlobalAttrField(out, 'value', '5'); // new default
  reconcileGlobals(doc);
  assert.equal(stateOutput(doc, 'A', out.name)?.value, '1'); // override preserved
  assert.equal(stateOutput(doc, 'B', out.name)?.value, '5'); // default followed
});

test('reconcile: an override that equals the new default reverts to GLOBAL_VAR', () => {
  const doc = reconcileDoc(['A']);
  const out = addOutput(doc, 'reg');
  const a = stateOutput(doc, 'A', out.name)!;
  a.value = '7';
  a.valueStatus = 'LOCAL';
  setGlobalAttrField(out, 'value', '7'); // default now equals the override
  reconcileGlobals(doc);
  assert.equal(stateOutput(doc, 'A', out.name)?.valueStatus, 'GLOBAL_VAR');
});

test('reconcile: a newly added state user-attribute reaches an existing state', () => {
  const doc = reconcileDoc(['A']);
  // Simulate the user adding a global state attribute directly to the list
  // (not via addUserAttribute, so it is NOT yet mirrored onto the state).
  doc.stateAttrs.push({
    name: 'foo', nameStatus: 'GLOBAL_FIXED', value: 'bar', valueStatus: 'GLOBAL_VAR',
    visibility: 1, visibilityStatus: 'GLOBAL_VAR', type: '', typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page: -1,
  });
  reconcileGlobals(doc);
  const foo = doc.states[0].attributes.find((a) => a.name === 'foo');
  assert.ok(foo, 'foo attribute should be added to the state');
  assert.equal(foo?.value, 'bar');
  assert.equal(foo?.page, doc.states[0].page); // page assigned from -1
});

test('reconcile: removing a global attribute drops it from every state (non-LOCAL)', () => {
  const doc = reconcileDoc(['A']);
  const attr = addUserAttribute(doc, STATE_ATTRS);
  assert.ok(doc.states[0].attributes.some((a) => a.name === attr.name));
  // Remove from the global list, then reconcile.
  doc.stateAttrs = doc.stateAttrs.filter((a) => a.name !== attr.name);
  reconcileGlobals(doc);
  assert.ok(!doc.states[0].attributes.some((a) => a.name === attr.name));
});

test('reconcile: reset ring follows the machine reset_state value', () => {
  const doc = reconcileDoc(['A', 'B']);
  addReset(doc); // adds reset_signal + reset_state (defaults to first state name)
  const rs = doc.machine.find((a) => a.name === 'reset_state')!;
  rs.value = 'B';
  reconcileGlobals(doc);
  assert.equal(doc.states.find((s) => s.name === 'A')?.reset, false);
  assert.equal(doc.states.find((s) => s.name === 'B')?.reset, true);
});

// Root-cause regression for "everything disappears after adding an output":
// a hand-created blank .fzm (docWithStates's shape - no machine/state/trans
// attribute headers, exactly what parseFzm('') produces) has shorter global
// lists than each state/transition's own attributes. reconcileGlobals's "drop
// attributes the global list no longer has" pass then deletes them, including
// the state's own name. main.ts's parseOrDefault avoids ever reconciling a doc
// shaped like this by seeding defaultDocument()'s header at load time instead
// - this test documents why that seeding is required, and that seeding it
// (reconcileDoc's shape) is what keeps the attribute.
test('reconcile on a header-less doc wipes a state\'s own name attribute (the bug)', () => {
  // docWithStates([]) alone gives the header-less shape (no stateAttrs); the
  // state itself is built directly, with its own "name" attribute, matching
  // what parseFzm produces for a hand-created blank .fzm - the file's own
  // per-object attribute values are read regardless of whether the global
  // header sections exist. createState() can no longer stand in here since it
  // now seeds a new state's attributes from doc.stateAttrs itself (see
  // updateAttrib in edit.ts's createState) - on an empty global list that
  // correctly yields no attributes at all, which isn't what this test is
  // about: it's specifically about reconcile's own separate wiping behavior.
  const doc = docWithStates([]);
  doc.states.push({
    name: 'A', x0: 0, y0: 0, x1: 10, y1: 10, reset: false, page: 1, color: -16777216,
    attributes: [{
      name: 'name', nameStatus: 'ABS', value: 'A', valueStatus: 'LOCAL',
      visibility: 1, visibilityStatus: 'GLOBAL_VAR', type: 'def_type', typeStatus: 'GLOBAL_VAR',
      comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
      useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
      x2Obj: 0, y2Obj: 0, page: -1,
    }],
  });
  assert.equal(doc.stateAttrs.length, 0); // no header - what parseFzm('') produces
  assert.ok(hasAttr(doc.states[0].attributes, 'name'));
  reconcileGlobals(doc);
  assert.ok(!hasAttr(doc.states[0].attributes, 'name'), 'name attribute was wiped by reconcile');
});

test('reconcile on a properly-headered doc preserves the name attribute (the fix)', () => {
  const doc = reconcileDoc(['A']);
  assert.ok(doc.stateAttrs.length > 0); // defaultDocument()'s seeded header
  assert.ok(hasAttr(doc.states[0].attributes, 'name'));
  reconcileGlobals(doc);
  assert.ok(hasAttr(doc.states[0].attributes, 'name'));
  assert.equal(doc.states[0].attributes.find((a) => a.name === 'name')?.value, 'A');
});

// --- Outputs-tab validations (MyTableModel.setValueAt rules) --------------

test('validateOutputEdit: reset value only allowed on regdp/flag', () => {
  const doc = reconcileDoc(['A']);
  const out = addOutput(doc, 'reg');
  // Typing a reset value on a reg output is rejected.
  assert.ok(validateOutputEdit(out, 7, '3'));
  // regdp and flag allow it.
  out.type = 'regdp';
  assert.equal(validateOutputEdit(out, 7, '3'), null);
  // Changing type away from regdp/flag while a resetval exists is rejected.
  out.resetval = '3';
  assert.ok(validateOutputEdit(out, 3, 'reg'));
});

test('validateOutputEdit: flags cannot have default values', () => {
  const doc = reconcileDoc(['A']);
  const out = addOutput(doc, 'flag');
  assert.ok(validateOutputEdit(out, 1, '1')); // setting a default on a flag
  // Switching an output with a default to flag is rejected.
  const reg = addOutput(doc, 'reg'); // default "0"
  assert.ok(validateOutputEdit(reg, 3, 'flag'));
});

test('hasReset reflects reset_signal + reset_state presence', () => {
  const doc = reconcileDoc(['A']);
  assert.equal(hasReset(doc), false);
  addReset(doc);
  assert.equal(hasReset(doc), true);
});

test('sanitizeLocalOutputTypes reverts a stray output type on a non-output attr', () => {
  const doc = reconcileDoc(['A']);
  const out = addOutput(doc, 'reg');
  const s = doc.states[0];
  // A legit output attribute (name matches a declared output) is left alone.
  const legit = s.attributes.find((a) => a.name === out.name && a.type === 'output')!;
  // A stray local attribute mistakenly typed "output".
  s.attributes.push({
    name: 'bogus', nameStatus: 'LOCAL', value: '', valueStatus: 'LOCAL',
    visibility: 1, visibilityStatus: 'LOCAL', type: 'output', typeStatus: 'LOCAL',
    comment: '', commentStatus: 'LOCAL', color: -16777216, colorStatus: 'LOCAL',
    useratts: '', userattsStatus: 'LOCAL', resetval: '', resetvalStatus: 'LOCAL',
    x2Obj: 0, y2Obj: 0, page: 1,
  });
  sanitizeLocalOutputTypes(s.attributes, doc.outputs);
  assert.equal(legit.type, 'output'); // untouched
  assert.equal(s.attributes.find((a) => a.name === 'bogus')?.type, ''); // reverted
});
