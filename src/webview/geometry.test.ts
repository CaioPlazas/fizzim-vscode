import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { adjustStubAnchor, adjustStubTip, createStubGeometry, getBorderPts, moveTransition, recomputeCrossPage, recomputeLoopback, recomputeStub, recomputeTransition, restaggerCrossPage, translateCrossPage, translateTransitionOnly, updatePageConnectors } from './geometry';
import { createTransition } from './edit';
import { DEFAULT_PREFERENCES, FzmDocument, FzmLoopback, FzmState, FzmTransition, ObjAttribute } from '../fzm/model';

function makeState(name: string, x0: number, y0: number, x1: number, y1: number): FzmState {
  return { name, x0, y0, x1, y1, reset: false, page: 1, color: -16777216, attributes: [] };
}

function makeStub(): FzmTransition {
  return {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: true, attributes: [],
  };
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
// createTransition seeds a new object from these lists, so a doc without
// them isn't a realistic starting point (F20).
function docWith(states: FzmState[]): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [],
    stateAttrs: [globalAttr('name', 'def_name', 1)],
    transAttrs: [globalAttr('name', 'def_name', 0), globalAttr('equation', '1', 1)],
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

test('moveTransition preserves a hand-dragged control point when the state moves a small amount', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  };
  recomputeTransition(t, a, b); // seed real geometry, as transition creation does

  // simulate the user hand-dragging the curve into a custom shape
  t.startCtrlPt = { x: t.startPt.x + 15, y: t.startPt.y - 90 };
  t.endCtrlPt = { x: t.endPt.x - 40, y: t.endPt.y + 25 };
  const startOffset = { x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y };
  const endOffset = { x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y };
  const frozenIndices = { start: t.startStateIndex, end: t.endStateIndex };

  // nudge state A a few px, as a drag or arrow-key press would
  const moved = makeState('A', 5, 3, 105, 103);
  moveTransition(t, moved, b);

  assert.deepEqual({ start: t.startStateIndex, end: t.endStateIndex }, frozenIndices, 'border indices stay frozen on a small move');
  assert.deepEqual(
    { x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y },
    startOffset,
    'hand-dragged start control point offset is preserved, not reset'
  );
  assert.deepEqual(
    { x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y },
    endOffset,
    'hand-dragged end control point offset is preserved, not reset'
  );
});

test('moveTransition survives repeated 1px nudges without resetting the curve (regression: arrow-key nudges used to wipe hand-placed curves)', () => {
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
  t.startCtrlPt = { x: t.startPt.x + 15, y: t.startPt.y - 90 };
  t.endCtrlPt = { x: t.endPt.x - 40, y: t.endPt.y + 25 };
  const startOffset = { x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y };
  const endOffset = { x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y };

  let s = a;
  for (let i = 0; i < 20; i++) {
    s = makeState('A', s.x0 + 1, s.y0, s.x1 + 1, s.y1); // one arrow-key nudge each
    moveTransition(t, s, b);
  }

  assert.deepEqual({ x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y }, startOffset);
  assert.deepEqual({ x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y }, endOffset);
});

test('moveTransition falls back to a full recompute when the states swap relative sides', () => {
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
  t.startCtrlPt = { x: t.startPt.x + 15, y: t.startPt.y - 90 };
  t.endCtrlPt = { x: t.endPt.x - 40, y: t.endPt.y + 25 };

  // drag B to the far left of A - a genuine structural change, not a small move
  const movedB = makeState('B', -500, 0, -400, 100);
  moveTransition(t, a, movedB);

  const fresh: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  };
  recomputeTransition(fresh, a, movedB);

  assert.deepEqual(t.startPt, fresh.startPt, 'flipped move re-derives geometry via the full recompute path, matching a fresh recompute');
  assert.deepEqual(t.endPt, fresh.endPt);
  assert.deepEqual(t.startCtrlPt, fresh.startCtrlPt);
  assert.deepEqual(t.endCtrlPt, fresh.endCtrlPt);
});

// F6(b): recalcCheck compares against the drag-start baseline
// (StateTransitionObj.setParentModified, called once on mouse-down), not the
// previous mousemove's result - so a slow multi-frame drag whose cumulative
// displacement crosses the +-20px quadrant tolerance is still caught, even
// though no single per-frame delta does.
test('moveTransition catches a quadrant flip that only shows up cumulatively across many small per-frame steps (F6b)', () => {
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
  const baseline = { startPt: { ...t.startPt }, endPt: { ...t.endPt } };

  // Drag A far to the right of B in 30 one-pixel-per-frame steps: each
  // individual step is tiny, but the total (300+px) swaps which state is
  // "left" of the other - a real quadrant flip only visible cumulatively.
  let s = a;
  for (let i = 0; i < 700; i++) {
    s = makeState('A', s.x0 + 1, s.y0, s.x1 + 1, s.y1);
    moveTransition(t, s, b, baseline);
  }

  const fresh: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  };
  recomputeTransition(fresh, s, b);
  assert.deepEqual(t.startPt, fresh.startPt, 'the cumulative flip must trigger a full recompute, matching a fresh one');
  assert.deepEqual(t.endPt, fresh.endPt);
});

// F6(a): Java's unconditional override (StateTransitionObj.java:450, "or if
// multiple states selected, dont need to recalculate") - translateTransitionOnly
// never recomputes, even across a move that would otherwise flip the quadrant,
// because a rigid group drag never changes the two states' relative geometry.
test('translateTransitionOnly never recomputes, even across a would-be quadrant flip', () => {
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
  t.startCtrlPt = { x: t.startPt.x + 15, y: t.startPt.y - 90 };
  t.endCtrlPt = { x: t.endPt.x - 40, y: t.endPt.y + 25 };
  const startOffset = { x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y };
  const endOffset = { x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y };
  const frozenIndices = { start: t.startStateIndex, end: t.endStateIndex };

  // Both A and B moved together (a group drag) across a huge distance that
  // would trip moveTransition's flip check on its own.
  const movedA = makeState('A', 1000, 0, 1100, 100);
  const movedB = makeState('B', 1300, 0, 1400, 100);
  translateTransitionOnly(t, movedA, movedB);

  assert.deepEqual({ start: t.startStateIndex, end: t.endStateIndex }, frozenIndices, 'border indices never change');
  assert.deepEqual(
    { x: t.startCtrlPt.x - t.startPt.x, y: t.startCtrlPt.y - t.startPt.y },
    startOffset,
    'hand-dragged control point offset survives a rigid group move intact'
  );
  assert.deepEqual({ x: t.endCtrlPt.x - t.endPt.x, y: t.endCtrlPt.y - t.endPt.y }, endOffset);
});

// F9: DrawArea.updatePageConn re-docks every cross-page connector on any
// page-size change, since pageS/pageSC sit at pageSizeW-50/-70 (stale
// otherwise until some endpoint state happens to move).
test('updatePageConnectors re-docks every cross-page connector to a new page size', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  b.page = 2;
  const doc = docWith([a, b]);
  const t = createTransition(doc, a, b, 1);
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50);

  doc.preferences.pageSizeW = 1400;
  updatePageConnectors(doc);
  assert.equal(t.pageS.x, 1400 - 50, 'connector re-docks to the widened page edge');
  assert.equal(t.pageSC.x, 1400 - 70);
});

// F10: adding/removing a cross-page sibling shifts the stagger of every other
// connector sharing either endpoint (DrawArea.pageConnUpdate/getOffset - a
// rank-out-of-total, so the group must be re-run as a whole, not just the one
// transition that changed).
test('restaggerCrossPage re-staggers every cross-page connector sharing a given state', () => {
  // getOffset's stagger is (rank - average) * 40 - with exactly 1 or 2
  // siblings the first-created one always lands at offset 0, so this needs 3
  // siblings on A's side to show rank 1's offset actually shift (0 -> -40)
  // once it's no longer alone.
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  const c = makeState('C', 300, 200, 400, 300);
  const d = makeState('D', 300, 400, 400, 500);
  b.page = c.page = d.page = 2;
  const doc = docWith([a, b, c, d]);
  const blank = (startState: string, endState: string): FzmTransition => ({
    kind: 'transition', name: `${startState}${endState}`, startState, endState,
    startPt: { x: 0, y: 0 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 0, y: 0 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: false, attributes: [],
  });
  const t1 = blank('A', 'B');
  doc.transitions.push(t1);
  recomputeCrossPage(doc, t1); // seed it alone, as if it were the only cross-page transition so far
  const before = { ...t1.pageS };

  // Two more cross-page siblings appear sharing A - t1's own geometry is
  // still stale (nothing has touched it) until restaggerCrossPage runs.
  const t2 = blank('A', 'C');
  const t3 = blank('A', 'D');
  doc.transitions.push(t2, t3);
  restaggerCrossPage(doc, ['A']);

  assert.notEqual(t1.pageS.y, before.y, 't1 must re-stagger once it has two more siblings on A');
  assert.notEqual(t1.pageS.y, t2.pageS.y);
  assert.notEqual(t2.pageS.y, t3.pageS.y);
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

test('recomputeStub preserves a zero-length stub instead of snapping it to a 60px default', () => {
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 100, y: 50 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 100, y: 50 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: true, attributes: [],
  }; // tip dragged onto its own anchor -> a legitimate zero-length stub
  const moved = makeState('A', 200, 0, 300, 100);
  recomputeStub(t, moved);
  assert.deepEqual(t.pageS, t.startPt, 'zero-length stub stays zero-length after the state moves, not snapped to a 60px default');
});

// The reported v2.0.8 bug: Ctrl+A, then drag the whole group toward the right
// border, and every stub arrow on it visibly shrank - "as if it were
// compensating for the border". recomputeStub used to re-derive len/angle from
// the previous call's already-Math.trunc'd pageS, so each of a drag's ~60
// mousemove events per second fed a slightly-wrong vector into the next one.
// The error never converged (shallow stubs lost ~1px per event, 45-60 degree
// ones grew), so a long drag could erase a stub entirely. Java stores len/angle
// and rebuilds pageS from them (StateTransitionObj.java:443-444), so its stubs
// are rigid across any number of moves - which is what this asserts.
test('a stub is rigid across hundreds of state moves, at every angle', () => {
  for (const deg of [0, 10, 20, 30, 45, 60, 90, 135, 180, 225, 270, 315]) {
    const s = makeState('A', 400, 400, 500, 500); // center (450,450), radius 50
    const t = makeStub();
    // Aim the tip at `deg` (screen Y grows downward, so negate the sine),
    // ~110px from the center = a ~60px stub beyond the border.
    const rad = (deg * Math.PI) / 180;
    adjustStubTip(t, s, Math.round(450 + 110 * Math.cos(rad)), Math.round(450 - 110 * Math.sin(rad)));

    // Settle once: a tip drag stores the CENTER->tip angle but pageS is
    // rebuilt from the ANCHOR, so the first rebuild snaps the tip onto that
    // radial by a pixel or two. Java does the same (its PAGES branch stores
    // getAngle(pageS, realCenter), moveEndPts rebuilds off startPt). What must
    // never change is everything after that.
    recomputeStub(t, s);
    const vec = { x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y };
    const len0 = Math.hypot(vec.x, vec.y);
    assert.ok(len0 > 40, `${deg}deg: sanity - stub should start out ~60px, got ${len0}`);

    // 200 successive one-pixel moves, exactly what a slow drag right produces.
    for (let i = 1; i <= 200; i++) {
      const moved = makeState('A', 400 + i, 400, 500 + i, 500);
      recomputeStub(t, moved);
      assert.deepEqual(
        { x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y },
        vec,
        `${deg}deg: stub vector must be identical after move ${i} (was ${JSON.stringify(vec)})`
      );
    }
  }
});

test('a stub keeps its length when its state is resized, not just moved', () => {
  const s = makeState('A', 400, 400, 500, 500);
  const t = makeStub();
  adjustStubTip(t, s, 560, 410); // a diagonal stub, the drift-prone case
  recomputeStub(t, s); // settle onto the stored radial (see the test above)
  const vec = { x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y };

  for (let i = 1; i <= 50; i++) {
    recomputeStub(t, makeState('A', 400, 400, 500 + i, 500 + i)); // grow the state
    assert.deepEqual(
      { x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y },
      vec,
      `stub vector must survive resize step ${i}`
    );
  }
});

test('a stub loaded from file derives len/angle once, then holds them', () => {
  const t = makeStub();
  t.startPt = { x: 100, y: 50 };
  t.pageS = { x: 160, y: 50 }; // straight out of the parser: no stubLen/stubAngle
  assert.equal(t.stubLen, undefined);

  recomputeStub(t, makeState('A', 0, 0, 100, 100));
  assert.equal(t.stubLen, 60, 'length derived from the file\'s own anchor->tip vector');
  assert.equal(Math.abs(t.stubAngle!), 0, 'a due-east stub reads as angle 0');
});

// F15: dragging the stub's anchor around the state's border used to just
// translate the tip by the border-point delta, preserving the old absolute
// direction - so dragging the anchor from the right side to the left left
// the arrow still pointing right, straight through the state. It must
// instead re-derive the outward angle from the state's CENTER through the
// new anchor, keeping the same length.
test('adjustStubAnchor rotates the tip outward from the state center as the anchor moves around the border', () => {
  const s = makeState('A', 0, 0, 100, 100); // center (50,50), radius 50
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 100, y: 50 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 160, y: 50 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: true, attributes: [],
  };
  const preLen = Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y);

  // Drag the anchor to the LEFT side of the state (border point 18).
  adjustStubAnchor(t, s, 0, 50);

  assert.equal(t.startStateIndex, 18, 'anchor snaps to the nearest border point (left side)');
  assert.deepEqual(t.startPt, { x: 0, y: 50 });
  // The tip must now point further LEFT (away from center), not still sit to
  // the right of the anchor (which would point back through the state body).
  assert.ok(t.pageS.x < t.startPt.x, `tip must point outward (left), got pageS.x=${t.pageS.x} vs startPt.x=${t.startPt.x}`);
  const postLen = Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y);
  assert.ok(Math.abs(postLen - preLen) <= 1, `stub length preserved (${preLen} -> ${postLen})`);
});

// F16 (drag side): dragging the tip used to only move pageS, never touching
// startStateIndex/startPt - so the visible anchor stayed stuck at its old
// spot instead of following the tip's new outward direction around to the
// border (StateTransitionObj's PAGES branch converts the tip's angle back to
// a border index and re-snaps the anchor to it).
test('adjustStubTip re-derives the anchor border index from the tip\'s new outward angle', () => {
  const s = makeState('A', 0, 0, 100, 100); // center (50,50)
  const t: FzmTransition = {
    kind: 'transition', name: 'trans0', startState: 'A', endState: 'B',
    startPt: { x: 100, y: 50 }, endPt: { x: 0, y: 0 }, startCtrlPt: { x: 0, y: 0 }, endCtrlPt: { x: 0, y: 0 },
    startStateIndex: 0, endStateIndex: 0, page: 1, color: -16777216,
    pageS: { x: 160, y: 50 }, pageSC: { x: 0, y: 0 }, pageE: { x: 0, y: 0 }, pageEC: { x: 0, y: 0 },
    stub: true, attributes: [],
  };

  // Drag the tip to a point far to the LEFT of the state's center.
  adjustStubTip(t, s, -100, 50);

  assert.deepEqual(t.pageS, { x: -100, y: 50 }, 'tip follows the drag exactly');
  assert.equal(t.startStateIndex, 18, 'anchor re-derives to the left border index from the tip\'s angle');
  assert.deepEqual(t.startPt, { x: 0, y: 50 }, 'anchor re-snaps to the new border point, not left behind');
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

// Companion to the stub-rigidity test above. recomputeCrossPage welds pageS to
// pageSizeW-50, and updateAttachedTransitions used to run it on every state-move
// frame - so dragging a state toward the right border left the pentagon behind
// and collapsed the connector. Java gets away with that because its canvas is
// hard-clamped to the page; this port isn't, so a plain move translates instead.
test('translateCrossPage moves the whole connector with the state, past the page edge', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  b.page = 2;
  const doc = docWith([a, b]);
  const t = createTransition(doc, a, b, 1);
  recomputeCrossPage(doc, t);
  const before = { pageS: { ...t.pageS }, pageSC: { ...t.pageSC }, startPt: { ...t.startPt } };
  const gapS = { x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y };
  const gapE = { x: t.pageE.x - t.endPt.x, y: t.pageE.y - t.endPt.y };

  // Shove A far past the right page edge, the exact gesture that used to
  // collapse the connector.
  const dx = doc.preferences.pageSizeW + 200;
  translateCrossPage(t, makeState('A', dx, 0, dx + 100, 100), b);

  assert.equal(t.startPt.x, before.startPt.x + dx, 'anchor follows the state');
  assert.equal(t.pageS.x, before.pageS.x + dx, 'pentagon travels with it');
  assert.equal(t.pageSC.x, before.pageSC.x + dx);
  assert.ok(t.pageS.x > doc.preferences.pageSizeW, 'and is allowed off the page, to be cut off');
  assert.deepEqual({ x: t.pageS.x - t.startPt.x, y: t.pageS.y - t.startPt.y }, gapS, 'connector keeps its exact shape');
  assert.deepEqual({ x: t.pageE.x - t.endPt.x, y: t.pageE.y - t.endPt.y }, gapE, 'the far side is untouched by a near-side move');
});

test('updatePageConnectors still re-docks a travelled connector, so Page Setup / Fit Page repairs it', () => {
  const a = makeState('A', 0, 0, 100, 100);
  const b = makeState('B', 300, 0, 400, 100);
  b.page = 2;
  const doc = docWith([a, b]);
  const t = createTransition(doc, a, b, 1);
  translateCrossPage(t, makeState('A', 900, 0, 1000, 100), b);
  assert.ok(t.pageS.x > doc.preferences.pageSizeW);

  updatePageConnectors(doc);
  assert.equal(t.pageS.x, doc.preferences.pageSizeW - 50, 'back on the page edge');
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
