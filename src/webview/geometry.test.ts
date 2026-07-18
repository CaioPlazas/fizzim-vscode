import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createStubGeometry, getBorderPts, recomputeCrossPage, recomputeLoopback, recomputeStub, recomputeTransition } from './geometry';
import { createTransition } from './edit';
import { DEFAULT_PREFERENCES, FzmDocument, FzmLoopback, FzmState, FzmTransition } from '../fzm/model';

function makeState(name: string, x0: number, y0: number, x1: number, y1: number): FzmState {
  return { name, x0, y0, x1, y1, reset: false, page: 1, color: -16777216, attributes: [] };
}

function docWith(states: FzmState[]): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [], stateAttrs: [], transAttrs: [],
    tabs: ['Page 1', 'Page 2'], preferences: { ...DEFAULT_PREFERENCES },
    states, transitions: [], texts: [],
  };
}

test('getBorderPts returns 36 points, index 0 on the rightmost edge', () => {
  const s = makeState('A', 0, 0, 100, 100);
  const pts = getBorderPts(s);
  assert.equal(pts.length, 36);
  assert.deepEqual(pts[0], { x: 100, y: 50 });
});

test('getBorderPts index 18 (halfway around) is on the leftmost edge', () => {
  const s = makeState('A', 0, 0, 100, 100);
  const pts = getBorderPts(s);
  assert.equal(pts[18].x, 0);
  assert.equal(pts[18].y, 50);
});

test('recomputeTransition anchors the curve between two states, start left of end for a left-to-right layout', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  };

  recomputeTransition(t, a, b);

  // start point should sit on A's right-ish side, end point on B's left-ish side
  assert.ok(t.startPt.x > 40, `expected startPt.x > 40, got ${t.startPt.x}`);
  assert.ok(t.endPt.x < 360, `expected endPt.x < 360, got ${t.endPt.x}`);
  assert.ok(Number.isFinite(t.startCtrlPt.x) && Number.isFinite(t.startCtrlPt.y));
  assert.ok(Number.isFinite(t.endCtrlPt.x) && Number.isFinite(t.endCtrlPt.y));
});

test('createStubGeometry anchors at border point 0 with the tip 60px to the right', () => {
  const s = makeState('A', 0, 0, 100, 100);
  const geo = createStubGeometry(s);
  assert.equal(geo.startStateIndex, 0);
  assert.deepEqual(geo.startPt, { x: 100, y: 50 });
  assert.deepEqual(geo.pageS, { x: 160, y: 50 });
});

test('recomputeStub re-anchors the stub to the moved state, preserving its length and angle', () => {
  const s = makeState('A', 0, 0, 100, 100);
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 100, y: 50 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 160, y: 50 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: true, attributes: [],
  };
  const preLen = Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y);
  const moved = makeState('A', 200, 0, 300, 100); // shifted +200 in x
  recomputeStub(t, moved);
  assert.deepEqual(t.startPt, { x: 300, y: 50 }, 'startPt follows border point 0 of the moved state');
  const postLen = Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y);
  assert.ok(Math.abs(postLen - preLen) <= 1, `stub length preserved (${preLen} -> ${postLen})`);
  assert.deepEqual(t.pageS, { x: 360, y: 50 }, 'tip stays 60px to the right after the move');
});

test('recomputeLoopback preserves border indices and keeps control points at the same distance from their anchor', () => {
  const s = makeState('IDLE', 0, 0, 100, 100);
  const initialBorderPts = getBorderPts(s);
  const t: FzmLoopback = {
    kind: 'loopback', name: 'trans5', state: 'IDLE',
    startPt: initialBorderPts[0], endPt: initialBorderPts[5],
    startCtrlPt: { x: initialBorderPts[0].x + 20, y: initialBorderPts[0].y },
    endCtrlPt: { x: initialBorderPts[5].x + 20, y: initialBorderPts[5].y },
    startStateIndex: 0, endStateIndex: 5, page: 1, color: -16777216, attributes: [],
  };
  const preLenS = Math.hypot(t.startCtrlPt.x - t.startPt.x, t.startCtrlPt.y - t.startPt.y);

  // move the state 200px to the right, then recompute
  const moved = makeState('IDLE', 200, 0, 300, 100);
  recomputeLoopback(t, moved);

  assert.equal(t.startStateIndex, 0);
  assert.equal(t.endStateIndex, 5);
  const postLenS = Math.hypot(t.startCtrlPt.x - t.startPt.x, t.startCtrlPt.y - t.startPt.y);
  assert.ok(Math.abs(postLenS - preLenS) <= 1, `expected control point distance preserved, got ${preLenS} -> ${postLenS}`);
  // the loop should have translated along with the state
  assert.equal(t.startPt.x, getBorderPts(moved)[0].x);
});

test('recomputeLoopback does not compound growth across many resize events (regression: arm used to inflate on every drag)', () => {
  // Repeatedly resizing (or moving) a state re-runs recomputeLoopback once per
  // mousemove. The old implementation re-derived each control point's
  // angle/length from the *previous* call's already-rounded points, and
  // truncated the result - a bias that compounded over hundreds of events
  // into a visibly growing loopback arm. The fix translates each control
  // point by its anchor's exact delta instead, so arm length must stay
  // constant no matter how many times this runs.
  const s = makeState('IDLE', 100, 100, 230, 230);
  const pts = getBorderPts(s);
  const startStateIndex = 2, endStateIndex = 7;
  const t: FzmLoopback = {
    kind: 'loopback', name: 'loop0', state: 'IDLE',
    startPt: pts[startStateIndex], endPt: pts[endStateIndex],
    startCtrlPt: { x: pts[startStateIndex].x + 60, y: pts[startStateIndex].y - 40 },
    endCtrlPt: { x: pts[endStateIndex].x - 40, y: pts[endStateIndex].y + 60 },
    startStateIndex, endStateIndex, page: 1, color: -16777216, attributes: [],
  };
  const armLen = () => ({
    s: Math.hypot(t.startCtrlPt.x - t.startPt.x, t.startCtrlPt.y - t.startPt.y),
    e: Math.hypot(t.endCtrlPt.x - t.endPt.x, t.endCtrlPt.y - t.endPt.y),
  });
  const initial = armLen();

  // Simulate 5 drag gestures of a corner resize handle: +1px x 30, then
  // -1px x 30 (grow then shrink back), recomputing on every mousemove.
  for (let gesture = 0; gesture < 5; gesture++) {
    for (let i = 0; i < 60; i++) {
      const d = i < 30 ? 1 : -1;
      s.x1 += d;
      s.y1 += d;
      recomputeLoopback(t, s);
    }
  }

  const final = armLen();
  assert.equal(final.s, initial.s, `start arm must not drift, got ${initial.s} -> ${final.s}`);
  assert.equal(final.e, initial.e, `end arm must not drift, got ${initial.e} -> ${final.e}`);
});

test('recomputeCrossPage docks the connector to the page edges and squares off the control points', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  b.page = 2;
  const doc = docWith([a, b]);
  const t = createTransition(doc, a, b, 1);
  recomputeCrossPage(doc, t);
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50);
  assert.equal(t.pageSC.x, doc.preferences.pageSizeW - 70);
  assert.equal(t.pageE.x, 50);
  assert.equal(t.pageEC.x, 70);
  assert.equal(t.startCtrlPt.x, t.startPt.x + 20);
  assert.equal(t.endCtrlPt.x, t.endPt.x - 20);
});

test('two cross-page transitions sharing a start state are staggered apart at the page edge', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  const c = makeState('C', 300, 200, 400, 300);
  b.page = 2;
  c.page = 2;
  const doc = docWith([a, b, c]);
  const t1 = createTransition(doc, a, b, 1);
  const t2 = createTransition(doc, a, c, 1);
  recomputeCrossPage(doc, t1);
  recomputeCrossPage(doc, t2);
  // getOffset staggers siblings (sOffset 0 vs 40, which also shifts the border
  // index), so the two connectors don't land on top of each other.
  assert.notEqual(t1.pageS.y, t2.pageS.y);
  assert.ok(t2.pageS.y > t1.pageS.y);
  assert.equal(t1.pageS.x, doc.preferences.pageSizeW - 50);
  assert.equal(t2.pageS.x, doc.preferences.pageSizeW - 50);
});
