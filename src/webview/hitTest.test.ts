import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { crossPageHit, normRect, objectsInBox, pointInEllipse, stateHandleAt, transitionHandleAt } from './hitTest';
import { DEFAULT_PREFERENCES, FzmDocument, FzmState, FzmTransition, ObjAttribute } from '../fzm/model';

function state(x0: number, y0: number, x1: number, y1: number): FzmState {
  return { name: 'S', x0, y0, x1, y1, reset: false, page: 1, color: -16777216, attributes: [] };
}

function globalAttr(name: string, value: string, visibility: number): ObjAttribute {
  return {
    name, nameStatus: 'ABS', value, valueStatus: 'GLOBAL_VAR',
    visibility, visibilityStatus: 'GLOBAL_VAR', type: 'def_type', typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page: -1,
  };
}

// A real Fizzim document always has at least the reserved state/trans
// "name"/"equation" global attributes (defaultDocument() seeds the same) -
// keeping these non-empty matches the realistic-baseline convention used
// elsewhere, even though nothing in this file calls createState/
// createTransition (whose seeding is what makes an empty list a live trap) (F20).
function globalHeader() {
  return {
    machine: [] as ObjAttribute[],
    inputs: [] as ObjAttribute[],
    outputs: [] as ObjAttribute[],
    stateAttrs: [globalAttr('name', 'def_name', 1)],
    transAttrs: [globalAttr('name', 'def_name', 0), globalAttr('equation', '1', 1)],
  };
}

test('normRect orders corners', () => {
  assert.deepEqual(normRect(100, 80, 10, 20), { x0: 10, y0: 20, x1: 100, y1: 80 });
});

test('objectsInBox selects only fully-contained states and text on the page', () => {
  const doc: FzmDocument = {
    version: '14.02.28', versionInt: 140228, ...globalHeader(),
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
  doc.states.push({ ...state(20, 20, 80, 80), name: 'inside' });
  doc.states.push({ ...state(200, 200, 260, 260), name: 'outside' });
  doc.states.push({ ...state(50, 50, 300, 90), name: 'partial' }); // extends past the box
  doc.states.push({ ...state(20, 20, 80, 80), name: 'otherpage', page: 2 });
  doc.texts.push({ text: 'note', isGlobalTable: false, x: 40, y: 40, page: 1 });
  doc.texts.push({ text: null, isGlobalTable: true, x: 40, y: 40, page: 1 }); // global table excluded

  const sels = objectsInBox(doc, 1, normRect(0, 0, 150, 150));
  const names = sels.filter((s) => s.kind === 'state').map((s) => doc.states[s.index].name);
  assert.deepEqual(names.sort(), ['inside']);
  assert.equal(sels.filter((s) => s.kind === 'text').length, 1); // the free-text note, not the global table
});

test('stateHandleAt detects each corner within tolerance, null elsewhere', () => {
  const s = state(0, 0, 100, 80);
  assert.equal(stateHandleAt(s, 0, 0, 6), 'tl');
  assert.equal(stateHandleAt(s, 100, 0, 6), 'tr');
  assert.equal(stateHandleAt(s, 0, 80, 6), 'bl');
  assert.equal(stateHandleAt(s, 100, 80, 6), 'br');
  assert.equal(stateHandleAt(s, 50, 40, 6), null); // center
  assert.equal(stateHandleAt(s, 20, 0, 6), null); // on top edge but not a corner
});

test('transitionHandleAt detects control points and endpoints', () => {
  const t: FzmTransition = {
    kind: 'transition', name: 't', startState: 'A', endState: 'B',
    startPt: { x: 10, y: 10 }, endPt: { x: 200, y: 200 },
    startCtrlPt: { x: 50, y: 40 }, endCtrlPt: { x: 160, y: 170 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  };
  assert.equal(transitionHandleAt(t, 10, 10, 6), 'start');
  assert.equal(transitionHandleAt(t, 200, 200, 6), 'end');
  assert.equal(transitionHandleAt(t, 50, 40, 6), 'startCtrl');
  assert.equal(transitionHandleAt(t, 160, 170, 6), 'endCtrl');
  assert.equal(transitionHandleAt(t, 100, 100, 6), null);
});

test('point at ellipse center is inside', () => {
  assert.equal(pointInEllipse(100, 100, 100, 100, 50, 30), true);
});

test('point on ellipse boundary (major axis) is inside', () => {
  assert.equal(pointInEllipse(150, 100, 100, 100, 50, 30), true);
});

test('point just outside ellipse boundary is outside', () => {
  assert.equal(pointInEllipse(151, 100, 100, 100, 50, 30), false);
});

test('point far outside is outside', () => {
  assert.equal(pointInEllipse(0, 0, 100, 100, 50, 30), false);
});

test('degenerate zero-radius ellipse never hits', () => {
  assert.equal(pointInEllipse(100, 100, 100, 100, 0, 0), false);
});

function crossPageDoc(): { doc: FzmDocument; t: FzmTransition } {
  const a: FzmState = { ...state(0, 0, 100, 100), name: 'A', page: 1 };
  const b: FzmState = { ...state(0, 0, 100, 100), name: 'B', page: 2 };
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 100, y: 50 }, endPt: { x: 0, y: 50 },
    startCtrlPt: { x: 120, y: 50 }, endCtrlPt: { x: -20, y: 50 },
    startStateIndex: 0, endStateIndex: 18, page: 1, color: -16777216,
    pageS: { x: 400, y: 50 }, pageSC: { x: 380, y: 50 },
    pageE: { x: 50, y: 50 }, pageEC: { x: 70, y: 50 },
    stub: false, attributes: [],
  };
  const doc: FzmDocument = {
    version: '14.02.28', versionInt: 140228, ...globalHeader(),
    tabs: ['Page 1', 'Page 2'], preferences: { ...DEFAULT_PREFERENCES }, states: [a, b], transitions: [t], texts: [],
  };
  return { doc, t };
}

test('crossPageHit: source bezier hits on page 1, dest bezier hits on page 2', () => {
  const { doc, t } = crossPageDoc();
  // The source side runs 100,50 -> 400,50 along y=50; sample a midpoint.
  assert.equal(crossPageHit(doc, t, 1, 250, 50), true, 'on the source bezier');
  assert.equal(crossPageHit(doc, t, 2, 25, 50), true, 'on the dest bezier');
});

test('crossPageHit: inside the source pentagon hits; a far-away point does not', () => {
  const { doc, t } = crossPageDoc();
  // Source pentagon spans pageS.x .. pageS.x+40, pageS.y-10 .. +10.
  assert.equal(crossPageHit(doc, t, 1, 420, 55), true, 'inside the pentagon');
  assert.equal(crossPageHit(doc, t, 1, 250, 400), false, 'far away');
  assert.equal(crossPageHit(doc, t, 3, 250, 50), false, 'neither endpoint on page 3');
});

test('transitionHandleAt exposes only this page-side handles for a cross-page transition', () => {
  const { t } = crossPageDoc();
  assert.equal(transitionHandleAt(t, 400, 50, 6, 'source'), 'pageS');
  assert.equal(transitionHandleAt(t, 380, 50, 6, 'source'), 'pageSC');
  assert.equal(transitionHandleAt(t, 100, 50, 6, 'source'), 'start');
  assert.equal(transitionHandleAt(t, 50, 50, 6, 'source'), null, 'dest handles are not on the source page');
  assert.equal(transitionHandleAt(t, 50, 50, 6, 'dest'), 'pageE');
  assert.equal(transitionHandleAt(t, 70, 50, 6, 'dest'), 'pageEC');
  assert.equal(transitionHandleAt(t, 0, 50, 6, 'dest'), 'end');
});
