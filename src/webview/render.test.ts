import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { attrIsVisible, attrLabelText, buildGlobalTableRows, buildOutputInfo, computeBounds, curveAnchor, render, stateAnchor, transitionOnPage, visibleAttrLabels } from './render';
import { createState, createTransition } from './edit';
import { addInput, addOutput } from './globals';
import { DEFAULT_PREFERENCES, FzmDocument, ObjAttribute } from '../fzm/model';

// A canvas context stub recording just the transforms render() sets.
function fakeCtx(bufferW: number, bufferH: number) {
  const transforms: number[][] = [];
  const ctx = {
    canvas: { width: bufferW, height: bufferH },
    font: '', fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 0, globalAlpha: 1, textAlign: '',
    setTransform: (...a: number[]) => void transforms.push(a),
    fillRect: () => {}, moveTo: () => {}, lineTo: () => {}, measureText: (t: string) => ({ width: t.length * 6 }),
    save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => {},
    stroke: () => {}, fill: () => {}, fillText: () => {}, strokeRect: () => {}, ellipse: () => {}, bezierCurveTo: () => {}, setLineDash: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, transforms };
}

test('render scales its transform by zoom x dpr (HiDPI crispness)', () => {
  // Guards the dpr fix: sizing the buffer in device pixels and scaling by
  // zoom x dpr keeps strokes on real pixels instead of being resampled.
  const { ctx, transforms } = fakeCtx(800, 600);
  render(ctx, emptyDoc(), 1, null, { zoom: 1.5, dpr: 2, fg: '#000', bg: '#fff' });
  assert.deepEqual(transforms[0], [1, 0, 0, 1, 0, 0], 'first transform paints the surface');
  assert.deepEqual(transforms[1], [3, 0, 0, 3, 0, 0], 'zoom 1.5 x dpr 2 = scale 3');
});

test('render defaults to dpr 1, so export and non-HiDPI stay unscaled', () => {
  const { ctx, transforms } = fakeCtx(400, 300);
  render(ctx, emptyDoc(), 1, null, { zoom: 1, fg: '#000', bg: '#fff' });
  assert.deepEqual(transforms[1], [1, 0, 0, 1, 0, 0]);
});

function attr(over: Partial<ObjAttribute>): ObjAttribute {
  return {
    name: 'a', nameStatus: 'GLOBAL_FIXED', value: 'v', valueStatus: 'LOCAL',
    visibility: 1, visibilityStatus: 'LOCAL', type: '', typeStatus: 'LOCAL',
    comment: '', commentStatus: 'LOCAL', color: -16777216, colorStatus: 'LOCAL',
    useratts: '', userattsStatus: 'LOCAL', resetval: '', resetvalStatus: 'LOCAL',
    x2Obj: 0, y2Obj: 0, page: 1, ...over,
  };
}

function emptyDoc(): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [], stateAttrs: [], transAttrs: [],
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
}

test('attrIsVisible: vis 1 always shows; vis 2 only when value is a local override; vis 0 never', () => {
  assert.equal(attrIsVisible(attr({ visibility: 1, valueStatus: 'GLOBAL_VAR' })), true);
  assert.equal(attrIsVisible(attr({ visibility: 2, valueStatus: 'LOCAL' })), true);
  assert.equal(attrIsVisible(attr({ visibility: 2, valueStatus: 'GLOBAL_VAR' })), false);
  assert.equal(attrIsVisible(attr({ visibility: 0, valueStatus: 'LOCAL' })), false);
});

test('attrLabelText: name/equation show value only; reg outputs use <=; others use =', () => {
  const info = buildOutputInfo([
    { ...attr({ name: 'q', type: 'reg', value: '0' }) },
    { ...attr({ name: 'y', type: 'comb', value: '0' }) },
  ]);
  assert.equal(attrLabelText(attr({ name: 'name', value: 'IDLE' }), info), 'IDLE');
  assert.equal(attrLabelText(attr({ name: 'equation', value: 'a&b' }), info), 'a&b');
  assert.equal(attrLabelText(attr({ name: 'q', type: 'output', value: '1' }), info), 'q <= 1');
  assert.equal(attrLabelText(attr({ name: 'y', type: 'output', value: '1' }), info), 'y = 1');
  assert.equal(attrLabelText(attr({ name: 'priority', value: '1000' }), info), 'priority = 1000');
});

test('visibleAttrLabels keeps only visible attributes, in order (Java step ordering)', () => {
  const info = buildOutputInfo([]);
  const labels = visibleAttrLabels([
    attr({ name: 'name', value: 'IDLE', visibility: 1 }),
    attr({ name: 'hidden', visibility: 0 }),
    attr({ name: 'priority', value: '5', visibility: 2, valueStatus: 'LOCAL' }),
  ], info);
  assert.deepEqual(labels.map((l) => l.text), ['IDLE', 'priority = 5']);
});

test('stateAnchor centers horizontally and sits a quarter down; curveAnchor is the endpoint midpoint', () => {
  const doc = emptyDoc();
  const s = createState(doc, 100, 200, 1);
  const a = stateAnchor(s);
  assert.equal(a.x, s.x0 + (s.x1 - s.x0) / 2);
  assert.equal(a.y, s.y0 + (s.y1 - s.y0) / 4);
  const b = createState(doc, 400, 200, 1);
  const t = createTransition(doc, s, b, 1);
  const c = curveAnchor(t);
  assert.equal(c.x, (t.startPt.x + t.endPt.x) / 2);
  assert.equal(c.y, (t.startPt.y + t.endPt.y) / 2);
});

test('computeBounds floors at the document page size', () => {
  const doc = emptyDoc(); // default pageSize 936 x 1296
  const b = computeBounds(doc, 1);
  assert.ok(b.width >= 936, `width ${b.width} should be >= page width`);
  assert.ok(b.height >= 1296, `height ${b.height} should be >= page height`);
});

test('computeBounds grows to include a state far outside the page', () => {
  const doc = emptyDoc();
  const s = createState(doc, 3000, 2500, 1); // far to the bottom-right
  const b = computeBounds(doc, 1);
  assert.ok(b.width >= s.x1, `width ${b.width} should include state right edge ${s.x1}`);
  assert.ok(b.height >= s.y1, `height ${b.height} should include state bottom edge ${s.y1}`);
});

test('computeBounds floorToPage=false ignores the page size and is idempotent for Fit Page', () => {
  const doc = emptyDoc(); // default page 936 x 1296, no content
  const s = createState(doc, 200, 150, 1); // small drawing well inside the page
  // Content-only bounds must be far smaller than the (large) page floor.
  const b = computeBounds(doc, 1, false);
  assert.ok(b.width < doc.preferences.pageSizeW, `content width ${b.width} should be < page ${doc.preferences.pageSizeW}`);
  assert.ok(b.width >= s.x1, `content width ${b.width} should still include the state`);
  // Simulate Fit Page writing the bounds back, then measuring again: the value
  // must not keep growing (the ratchet bug).
  doc.preferences.pageSizeW = Math.round(b.width);
  doc.preferences.pageSizeH = Math.round(b.height);
  const b2 = computeBounds(doc, 1, false);
  assert.equal(Math.round(b2.width), Math.round(b.width), 'Fit Page must be idempotent');
  assert.equal(Math.round(b2.height), Math.round(b.height), 'Fit Page must be idempotent');
});

test('computeBounds includes transition control points', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const t = createTransition(doc, a, b, 1);
  // Force a control point beyond everything else.
  t.endCtrlPt = { x: 9000, y: 8000 };
  const bounds = computeBounds(doc, 1);
  assert.ok(bounds.width >= 9000);
  assert.ok(bounds.height >= 8000);
});

test('buildGlobalTableRows lists non-empty sections with headers, "reg" shown as statebit', () => {
  const doc = emptyDoc();
  doc.machine.push({
    name: 'name', nameStatus: 'ABS', value: 'my_fsm', valueStatus: 'LOCAL', visibility: 0, visibilityStatus: 'GLOBAL_VAR',
    type: '', typeStatus: 'GLOBAL_VAR', comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR', x2Obj: 0, y2Obj: 0, page: -1,
  });
  addInput(doc);
  addOutput(doc, 'reg');
  const rows = buildGlobalTableRows(doc);
  // headers present for the non-empty sections
  const headers = rows.filter((r) => r.header).map((r) => r.c1);
  assert.ok(headers.includes('STATE MACHINE'));
  assert.ok(headers.includes('INPUTS'));
  assert.ok(headers.includes('OUTPUTS'));
  // reg output shown as statebit
  const outRow = rows.find((r) => !r.header && r.c1.trim() === 'out');
  assert.ok(outRow);
  assert.equal(outRow!.c3, 'statebit');
});

test('buildOutputInfo maps reg/flag to "<=" and comb to "="', () => {
  const doc = emptyDoc();
  createState(doc, 0, 0, 1);
  const reg = addOutput(doc, 'reg');
  const comb = addOutput(doc, 'comb');
  const info = buildOutputInfo(doc.outputs);
  assert.equal(info.get(reg.name)?.op, '<=');
  assert.equal(info.get(comb.name)?.op, '=');
});


test('transitionOnPage: visible only when both endpoint states share the page', () => {
  const doc = emptyDoc();
  const a = createState(doc, 0, 0, 1);
  const b = createState(doc, 300, 0, 1);
  const t = createTransition(doc, a, b, 1);
  assert.equal(transitionOnPage(doc, t, 1), true);
  b.page = 2; // now cross-page
  assert.equal(transitionOnPage(doc, t, 1), false);
  assert.equal(transitionOnPage(doc, t, 2), false);
});
