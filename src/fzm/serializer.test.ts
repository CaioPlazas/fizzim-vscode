import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFzm } from './parser';
import { serializeFzm } from './serializer';
import { defaultDocument } from './model';

test('defaultDocument serializes, parses back, and is re-serialize-stable', () => {
  const text = serializeFzm(defaultDocument());
  const doc = parseFzm(text);
  assert.equal(doc.machine.find((a) => a.name === 'name')?.value, 'def_name');
  assert.equal(doc.machine.find((a) => a.name === 'clock')?.value, 'clk');
  assert.deepEqual(doc.tabs, ['Page 1']);
  assert.equal(doc.states.length, 0);
  assert.equal(doc.texts.filter((t) => t.isGlobalTable).length, 1);
  assert.equal(serializeFzm(doc), text); // idempotent
});

test('customArgs preference round-trips', () => {
  const doc = defaultDocument();
  doc.preferences.customArgs = '-encoding onehot -force_undefined_goto_in_onehot';
  const reparsed = parseFzm(serializeFzm(doc));
  assert.equal(reparsed.preferences.customArgs, '-encoding onehot -force_undefined_goto_in_onehot');
});

const samplesDir = path.join(__dirname, '..', '..', 'samples');

function load(name: string): string {
  return fs.readFileSync(path.join(samplesDir, name), 'utf8');
}

const fixtures = ['cliff_classic_juststatesandtransitions.fzm', 'cliff_classic_4state2bit_iloop.fzm'];

for (const fixture of fixtures) {
  test(`round-trip parse -> serialize -> parse is stable: ${fixture}`, () => {
    const doc1 = parseFzm(load(fixture));
    const text2 = serializeFzm(doc1);
    const doc2 = parseFzm(text2);

    // States: same names, coordinates, reset flags
    assert.deepEqual(
      doc2.states.map((s) => ({ name: s.name, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, reset: s.reset })),
      doc1.states.map((s) => ({ name: s.name, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, reset: s.reset }))
    );

    // Transitions: same kind, endpoints, geometry
    assert.deepEqual(
      doc2.transitions.map((t) => ({ kind: t.kind, name: t.name, startPt: t.startPt, endPt: t.endPt, startCtrlPt: t.startCtrlPt, endCtrlPt: t.endCtrlPt })),
      doc1.transitions.map((t) => ({ kind: t.kind, name: t.name, startPt: t.startPt, endPt: t.endPt, startCtrlPt: t.startCtrlPt, endCtrlPt: t.endCtrlPt }))
    );

    // Machine attributes preserved
    assert.deepEqual(
      doc2.machine.map((a) => ({ name: a.name, value: a.value })),
      doc1.machine.map((a) => ({ name: a.name, value: a.value }))
    );

    // Tabs and preferences preserved
    assert.deepEqual(doc2.tabs, doc1.tabs);
    assert.deepEqual(doc2.preferences, doc1.preferences);
  });

  test(`round-trip is idempotent on second pass: ${fixture}`, () => {
    // serialize(parse(serialize(parse(x)))) === serialize(parse(x))
    const once = serializeFzm(parseFzm(load(fixture)));
    const twice = serializeFzm(parseFzm(once));
    assert.equal(twice, once);
  });
}

test('full attribute fields survive a round-trip (comment/color/useratts/resetval)', () => {
  const doc1 = parseFzm(load('cliff_classic_4state2bit_iloop.fzm'));
  const doc2 = parseFzm(serializeFzm(doc1));
  // pick the first machine attribute and compare all persisted fields
  assert.deepEqual(doc2.machine[0], doc1.machine[0]);
  // and a transition's equation attribute
  const eqn1 = doc1.transitions[0].attributes.find((a) => a.name === 'equation');
  const eqn2 = doc2.transitions[0].attributes.find((a) => a.name === 'equation');
  assert.deepEqual(eqn2, eqn1);
});

// F2 guard: Java reads x0/y0/x1/y1, x2Obj/y2Obj, and text x/y as ints
// (FileParser.java:471-474, :656-664, :375-377) - a fractional value throws
// NumberFormatException on load in real Fizzim. Dragging at a fractional zoom
// used to write these raw; the serializer now rounds them as a last-resort
// guard even though main.ts also rounds at every drag site.
test('fractional x0/y0/x1/y1/x2Obj/y2Obj/x/y are rounded to whole numbers on write', () => {
  const doc = defaultDocument();
  doc.states.push({
    name: 's0', x0: 10.4, y0: 20.6, x1: 90.5, y1: 60.5, reset: false, page: 1, color: -1,
    attributes: [{
      name: 'name', nameStatus: 'ABS', value: 's0', valueStatus: 'LOCAL',
      visibility: 1, visibilityStatus: 'GLOBAL_VAR', type: '', typeStatus: 'GLOBAL_VAR',
      comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
      useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
      x2Obj: 5.5, y2Obj: 9.4, page: -1,
    }],
  });
  doc.texts.push({ x: 3.5, y: 7.2, page: 1, text: 'hi', isGlobalTable: false });
  const text = serializeFzm(doc);
  for (const tag of ['x0', 'y0', 'x1', 'y1', 'x2Obj', 'y2Obj', 'x', 'y']) {
    const re = new RegExp(`<${tag}>\\n\\s*(-?\\d+(?:\\.\\d+)?)\\n`, 'g');
    let m;
    while ((m = re.exec(text))) {
      assert.equal(m[1].includes('.'), false, `<${tag}> should be a whole number, got "${m[1]}"`);
    }
  }
  const reparsed = parseFzm(text);
  assert.equal(reparsed.states[0].x0, 10);
  assert.equal(reparsed.states[0].y0, 21);
  assert.equal(reparsed.texts.find((t) => !t.isGlobalTable)?.x, 4);
});
