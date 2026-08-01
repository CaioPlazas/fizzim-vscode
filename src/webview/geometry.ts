import { FzmDocument, FzmLoopback, FzmState, FzmTransition, Point } from '../fzm/model';

// Ports the geometry from StateObj.getBorderPts() and
// StateTransitionObj/LoopbackTransitionObj's setEndPts()/updateObj().
// StateTransitionObj also has a moveEndPts() "fast path" (recalcCheck() in
// the Java source): on an ordinary state move/resize it keeps the
// transition's stored border index and translates its control points by
// their prior offset, only falling back to a full recompute when the two
// states' relative quadrant actually flips. That fast path is ported below
// as moveTransition() - it is NOT cosmetic: skipping it means any move of a
// connected state discards the user's hand-placed curve, which is a real
// bug, not just a redraw optimization.

export function getBorderPts(s: FzmState): Point[] {
  const pts: Point[] = [];
  // F17: Java's w/h are ints, so `w/2`/`h/2` are integer division, truncated
  // ONCE and reused for both the center offset and the cos/sin multiplier
  // (StateObj.java:272-286) - not the float w/2 our port used to compute
  // twice. For odd width/height this puts the center 0.5px differently,
  // shifting all 36 border points by up to 1px, which can flip which one
  // nearestBorderIndex picks for a near-tie.
  const halfW = Math.trunc((s.x1 - s.x0) / 2);
  const halfH = Math.trunc((s.y1 - s.y0) / 2);
  for (let i = 0; i < 36; i++) {
    const angle = ((2 * Math.PI) / 36) * i;
    pts.push({
      x: Math.trunc(s.x0 + halfW + halfW * Math.cos(angle)),
      y: Math.trunc(s.y0 + halfH + halfH * Math.sin(angle)),
    });
  }
  return pts;
}

function nearestBorderIndex(borderPts: Point[], from: Point): number {
  let bestIndex = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < borderPts.length; i++) {
    const dx = from.x - borderPts[i].x;
    const dy = from.y - borderPts[i].y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// Snaps a point to the nearest of a state's 36 border points (used when
// dragging a transition endpoint to re-anchor it, like Java's START/END drag).
export function nearestBorderPoint(state: FzmState, x: number, y: number): { point: Point; index: number } {
  const pts = getBorderPts(state);
  const index = nearestBorderIndex(pts, { x, y });
  return { point: pts[index], index };
}

function getAngle(outer: Point, inner: Point): number {
  const dx = outer.x - inner.x;
  const dy = -(outer.y - inner.y);
  let alpha = Math.atan2(dy, dx);
  if (alpha < 0) alpha += 2 * Math.PI;
  return alpha;
}

// F17: StateObj.getRealCenter uses integer division (int x0/x1/y0/y1).
function realCenter(s: FzmState): Point {
  return { x: s.x0 + Math.trunc((s.x1 - s.x0) / 2), y: s.y0 + Math.trunc((s.y1 - s.y0) / 2) };
}

export function recomputeTransition(t: FzmTransition, startState: FzmState, endState: FzmState): void {
  const startBorderPts = getBorderPts(startState);
  const endBorderPts = getBorderPts(endState);
  const startCoords = realCenter(startState);
  const endCoords = realCenter(endState);

  let endStateIndex = nearestBorderIndex(endBorderPts, startCoords);
  let startStateIndex = nearestBorderIndex(startBorderPts, endCoords);

  // nudge by one border point so transitions between the same pair of states don't fully overlap
  startStateIndex -= 1;
  if (startStateIndex === -1) startStateIndex = 35;
  endStateIndex += 1;
  if (endStateIndex === 36) endStateIndex = 0;

  const startPt = startBorderPts[startStateIndex];
  const endPt = endBorderPts[endStateIndex];

  const dx = startCoords.x - endCoords.x;
  const dy = startCoords.y - endCoords.y;

  let dxs = Math.trunc((endPt.x - startPt.x) / 3);
  let dys = Math.trunc((endPt.y - startPt.y) / 3);
  if (dxs < 0) dxs = -dxs;
  if (dys < 0) dys = -dys;

  let theta = 0;
  if (dx === 0) {
    theta = dy <= 0 ? Math.PI / 2 : (3 * Math.PI) / 2;
  } else if (dx > 0 && dy > 0) {
    theta = 2 * Math.PI - Math.atan(dy / dx);
  } else if (dx > 0 && dy <= 0) {
    theta = dy === 0 ? 0 : -Math.atan(dy / dx);
  } else if (dx < 0) {
    theta = Math.PI - Math.atan(dy / dx);
  }

  const adj = Math.PI / 6;
  let angleStart = 0;
  if (dx >= 0 && dy >= 0) angleStart = -Math.PI + theta + adj;
  else if (dx >= 0 && dy < 0) angleStart = Math.PI + theta + adj;
  else if (dx < 0 && dy >= 0) angleStart = -Math.PI + theta + adj;
  else if (dx < 0 && dy < 0) angleStart = Math.PI + theta + adj;

  const angleEnd = theta - adj;

  t.startPt = startPt;
  t.endPt = endPt;
  t.startStateIndex = startStateIndex;
  t.endStateIndex = endStateIndex;
  t.startCtrlPt = {
    x: Math.trunc(startPt.x + Math.cos(angleStart) * dxs),
    y: Math.trunc(startPt.y - Math.sin(angleStart) * dys),
  };
  t.endCtrlPt = {
    x: Math.trunc(endPt.x + Math.cos(angleEnd) * dxs),
    y: Math.trunc(endPt.y - Math.sin(angleEnd) * dys),
  };
}

// Ports StateTransitionObj.moveEndPts()'s fast path: called when a connected
// state moves or resizes but the transition itself wasn't touched. Keeps the
// transition's existing (frozen) startStateIndex/endStateIndex and translates
// its control points by the exact delta their anchor points just moved -
// preserving any hand-dragged curve shape exactly, the same technique
// recomputeLoopback already uses below. Falls back to the full
// recomputeTransition() (Java's setEndPts()) only when the states' relative
// quadrant has flipped by more than a 20px tolerance, mirroring Java's
// recalcCheck().
function translateTransition(t: FzmTransition, newStartPt: Point, newEndPt: Point): void {
  t.startCtrlPt = {
    x: t.startCtrlPt.x + (newStartPt.x - t.startPt.x),
    y: t.startCtrlPt.y + (newStartPt.y - t.startPt.y),
  };
  t.endCtrlPt = {
    x: t.endCtrlPt.x + (newEndPt.x - t.endPt.x),
    y: t.endCtrlPt.y + (newEndPt.y - t.endPt.y),
  };
  t.startPt = newStartPt;
  t.endPt = newEndPt;
}

// `baseline`, when given, is the transition's startPt/endPt as they were at
// the *start* of the drag (StateTransitionObj.setParentModified, called once
// on mouse-down) - recalcCheck (:1097-1109) always compares against that
// frozen snapshot, not the previous call's result, so a slow multi-frame drag
// that gradually crosses a quadrant boundary is still caught (each individual
// per-frame delta might be well under the +-20px tolerance even though the
// *total* since drag-start isn't). Omitting it falls back to the transition's
// current stored points, matching the old per-call behavior for one-shot
// callers like resizeState that have no "drag start" to snapshot.
export function moveTransition(
  t: FzmTransition,
  startState: FzmState,
  endState: FzmState,
  baseline?: { startPt: Point; endPt: Point }
): void {
  const startBorderPts = getBorderPts(startState);
  const endBorderPts = getBorderPts(endState);
  const newStartPt = startBorderPts[t.startStateIndex];
  const newEndPt = endBorderPts[t.endStateIndex];

  const base = baseline ?? { startPt: t.startPt, endPt: t.endPt };
  const dx1 = base.startPt.x - base.endPt.x;
  const dy1 = base.startPt.y - base.endPt.y;
  const dx2 = newStartPt.x - newEndPt.x;
  const dy2 = newStartPt.y - newEndPt.y;
  const flipped = !(
    ((dx1 >= 0 && dx2 >= -20) || (dx1 < 0 && dx2 < 20)) &&
    ((dy1 >= 0 && dy2 >= -20) || (dy1 < 0 && dy2 < 20))
  );

  if (flipped) {
    recomputeTransition(t, startState, endState);
    return;
  }
  translateTransition(t, newStartPt, newEndPt);
}

// Ports moveEndPts' unconditional override (StateTransitionObj.java:450, "or
// if multiple states selected, dont need to recalculate"): when both endpoint
// states are moving together (a group drag), always translate and never
// recompute, regardless of recalcCheck - a group drag's relative geometry
// between the two connected states never changes, so there is nothing to
// recompute a curve *for*.
export function translateTransitionOnly(t: FzmTransition, startState: FzmState, endState: FzmState): void {
  const newStartPt = getBorderPts(startState)[t.startStateIndex];
  const newEndPt = getBorderPts(endState)[t.endStateIndex];
  translateTransition(t, newStartPt, newEndPt);
}

// Ports LoopbackTransitionObj.setEndPts(x,y), used when a brand-new loopback
// is created by right-clicking a state. Note this uses the same raw,
// non-Y-flipped angle convention as getBorderPts() itself (angle = index *
// 2*PI/36, sin NOT negated) - unlike recomputeLoopback below, which derives
// its angle from an existing control point via getAngle() and so needs the
// Y-flip to convert back. Mixing the two conventions up would point new
// loopbacks' control points the wrong way.
export function createLoopbackGeometry(
  state: FzmState,
  clickPt: Point
): { startStateIndex: number; endStateIndex: number; startPt: Point; endPt: Point; startCtrlPt: Point; endCtrlPt: Point } {
  const borderPts = getBorderPts(state);
  const startStateIndex = nearestBorderIndex(borderPts, clickPt);
  let endStateIndex = startStateIndex + 5;
  if (endStateIndex > 35) endStateIndex -= 36;

  const startPt = borderPts[startStateIndex];
  const endPt = borderPts[endStateIndex];

  const angleStart = (startStateIndex * 2 * Math.PI) / 36;
  const angleEnd = (endStateIndex * 2 * Math.PI) / 36;

  const size = (state.x1 - state.x0) * (state.y1 - state.y0);
  const dist = Math.trunc(Math.trunc(Math.sqrt(size)) * 0.65);

  const startCtrlPt = { x: Math.trunc(dist * Math.cos(angleStart)) + startPt.x, y: dist * Math.sin(angleStart) + startPt.y };
  const endCtrlPt = { x: Math.trunc(dist * Math.cos(angleEnd)) + endPt.x, y: dist * Math.sin(angleEnd) + endPt.y };

  return { startStateIndex, endStateIndex, startPt, endPt, startCtrlPt, endCtrlPt };
}

// Initial geometry for a transition just switched to a "stub": Fizzim anchors
// it at border point 0 (the state's rightmost point) with the tip 60px to the
// right (StateTransitionObj.setEndPts, the `stub` branch: startPt =
// startBorderPts.get(0); pageS = startPt+(60,0); len=60; angle=0).
export function createStubGeometry(
  state: FzmState
): { startStateIndex: number; startPt: Point; pageS: Point; stubLen: number; stubAngle: number } {
  const borderPts = getBorderPts(state);
  const startPt = borderPts[0];
  return { startStateIndex: 0, startPt, pageS: { x: startPt.x + 60, y: startPt.y }, stubLen: 60, stubAngle: 0 };
}

// Java keeps a stub's length and outward angle in the `len`/`angle` fields and
// only ever rewrites them from a handle drag; on load it derives them once
// (StateTransitionObj.java:175-179). This mirrors that one-time derivation for
// a transition that came straight out of the parser (or predates these fields).
//
// Java derives the angle as getAngle(startPt, realCenter) - the outward
// direction through the anchor - rather than from the anchor->tip vector we use
// here. The two agree within the 36-point border quantization, since every
// handle drag re-snaps the anchor to the border point facing the tip, but using
// the anchor->tip vector keeps an already-saved stub pixel-identical instead of
// snapping its tip onto the nearest radial the first time its state moves.
function ensureStubLenAngle(t: FzmTransition): void {
  if (t.stubLen !== undefined && t.stubAngle !== undefined) return;
  t.stubAngle = getAngle(t.pageS, t.startPt);
  t.stubLen = Math.round(Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y));
}

// Re-anchors a stub when its start state moves/resizes: startPt snaps back to
// its border point and the tip (pageS) follows, preserving the stub's length
// and outward angle (StateTransitionObj.moveEndPts, `stub` branch, :443-444).
//
// The stored len/angle are load-bearing, not a cache. This used to re-derive
// both from the current startPt->pageS vector on every call, but pageS is
// Math.trunc'd on the way out, so each call fed a slightly-shortened vector
// back into the next one. A drag fires this once per mousemove event (~60/s),
// and the error does NOT converge: a 10-degree stub lost ~1px per event and a
// 60-degree one grew, so dragging a group across the page visibly shrank (or
// stretched) every stub on it. Java has no such drift because it never
// re-derives.
export function recomputeStub(t: FzmTransition, startState: FzmState): void {
  const borderPts = getBorderPts(startState);
  ensureStubLenAngle(t);
  const angle = t.stubAngle!;
  const len = t.stubLen!;
  t.startPt = borderPts[t.startStateIndex] ?? borderPts[0];
  t.pageS = { x: Math.trunc(t.startPt.x + len * Math.cos(angle)), y: Math.trunc(t.startPt.y - len * Math.sin(angle)) };
}

// Re-anchors a stub's ANCHOR end when the user drags it around the state's
// border (StateTransitionObj.adjustShapeOrPosition's START branch, :646-666):
// re-snap startPt to the nearest border point, then re-derive the tip's
// outward angle from the state's CENTER through the new anchor point,
// preserving the stub's existing length. A pure offset-translate (what this
// used to do) keeps the tip pointed in the old absolute direction, so
// dragging the anchor around to the far side of the state left the arrow
// pointing straight through the state body instead of rotating outward.
export function adjustStubAnchor(t: FzmTransition, startState: FzmState, x: number, y: number): void {
  const { point, index } = nearestBorderPoint(startState, x, y);
  ensureStubLenAngle(t);
  const len = t.stubLen!;
  t.startPt = point;
  t.startStateIndex = index;
  // Java's START branch rewrites `angle` and leaves `len` alone (:662-666).
  const angle = getAngle(point, realCenter(startState));
  t.stubAngle = angle;
  t.pageS = { x: Math.trunc(point.x + len * Math.cos(angle)), y: Math.trunc(point.y - len * Math.sin(angle)) };
}

// Re-anchors a stub's TIP end when dragged (adjustShapeOrPosition's PAGES
// branch, :688-703): the tip moves freely, then the outward angle from the
// state's center through the new tip position is converted back to a border
// index (Java's `index = 36 - round(angle/2*PI * 36)`), re-snapping the
// anchor to follow. Without this, dragging the tip only moved pageS, leaving
// startStateIndex/startPt (and the visible anchor) stuck at their old spot.
export function adjustStubTip(t: FzmTransition, startState: FzmState, x: number, y: number): void {
  t.pageS = { x, y };
  const angle = getAngle(t.pageS, realCenter(startState));
  let index = 36 - Math.round((angle / (Math.PI * 2)) * 36);
  if (index > 35) index -= 36;
  t.startStateIndex = index;
  t.startPt = getBorderPts(startState)[index];
  // Java's PAGES branch rewrites both fields (:693-703), measuring the new
  // length from the re-snapped anchor rather than from the raw drag point.
  t.stubAngle = angle;
  t.stubLen = Math.trunc(Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y));
}

// Re-anchors a loopback when its state moves/resizes. Java's updateObj
// re-derives each control point from the border point's angle/length every
// call - re-rounding on every call, which over many resize mousemove events
// (or repeated state moves) compounds into visible arm growth. We instead
// translate each control point by the same delta its border anchor point
// just moved by: this keeps the arm's shape rigid (zero drift, by
// construction) rather than re-deriving it from rounded trig each time, and
// matches the spirit of Java's own moveEndPts "fast path" that preserves
// deltas exactly this way for ordinary transitions.
export function recomputeLoopback(t: FzmLoopback, state: FzmState): void {
  const borderPts = getBorderPts(state);
  const newStartPt = borderPts[t.startStateIndex];
  const newEndPt = borderPts[t.endStateIndex];

  t.startCtrlPt = {
    x: t.startCtrlPt.x + (newStartPt.x - t.startPt.x),
    y: t.startCtrlPt.y + (newStartPt.y - t.startPt.y),
  };
  t.endCtrlPt = {
    x: t.endCtrlPt.x + (newEndPt.x - t.endPt.x),
    y: t.endCtrlPt.y + (newEndPt.y - t.endPt.y),
  };

  t.startPt = newStartPt;
  t.endPt = newEndPt;
}

// How far this cross-page transition is staggered from its siblings, porting
// DrawArea.getOffset: walk every cross-page transition sharing the same state on
// the given side, in list order; `numb` is this transition's 1-based position
// and `total` the count. Siblings end up 40px apart so their connectors don't
// overlap at the page edge.
function crossPageOffset(doc: FzmDocument, t: FzmTransition, side: 'start' | 'end'): number {
  const pageOf = new Map(doc.states.map((s) => [s.name, s.page]));
  const name = side === 'start' ? t.startState : t.endState;
  let total = 0;
  let numb = 0;
  for (const o of doc.transitions) {
    if (o.kind === 'loopback') continue;
    const sp = pageOf.get(o.startState);
    const ep = pageOf.get(o.endState);
    if (sp === undefined || ep === undefined || sp === ep) continue; // not cross-page
    if ((side === 'start' ? o.startState : o.endState) !== name) continue;
    total++;
    if (o === t) numb = total;
  }
  const avg = total % 2 !== 0 ? Math.trunc((total + 1) / 2) : Math.trunc(total / 2);
  return (numb - avg) * 40;
}

// Moves a cross-page connector rigidly with the state(s) that just moved:
// each side's anchor, control point and page-edge points shift by the same
// delta that side's border anchor did - the delta-translate technique
// recomputeLoopback and translateTransition already use.
//
// Java instead re-docks (recomputeCrossPage, below) on every state move, and
// that IS what StateTransitionObj.moveEndPts does. It is invisible there only
// because Java's canvas is hard-bounded to the page: FizzimGui.java:1491-1494
// sizes DrawArea to exactly maxW x maxH, DrawArea.mouseDragged:738-748 clamps
// the cursor into it, and moveOnResize drags objects back in when the page
// shrinks - so a state can never travel far from the page edge the connector
// is pinned to. This port deliberately dropped that clamp (NEXT_STEP.md round
// 2, STEP 10: growing the canvas by dragging past the edge is a feature), which
// turned the re-dock into a visible defect - drag a group toward the right
// border and the pentagon stayed welded to pageSizeW-50 while its anchor kept
// going, collapsing the connector to nothing and then inverting it. Translating
// instead also stops a plain state move from discarding a hand-dragged
// connector shape. A full re-dock still runs on every genuine topology change
// (create, reconnect, page move, sibling re-stagger) and on any page-size
// change via updatePageConnectors - so Page Setup / Fit Page re-docks it.
export function translateCrossPage(t: FzmTransition, startState: FzmState, endState: FzmState): void {
  const newStartPt = getBorderPts(startState)[t.startStateIndex];
  const newEndPt = getBorderPts(endState)[t.endStateIndex];
  if (!newStartPt || !newEndPt) return;

  const sdx = newStartPt.x - t.startPt.x, sdy = newStartPt.y - t.startPt.y;
  const edx = newEndPt.x - t.endPt.x, edy = newEndPt.y - t.endPt.y;

  t.startCtrlPt = { x: t.startCtrlPt.x + sdx, y: t.startCtrlPt.y + sdy };
  t.pageS = { x: t.pageS.x + sdx, y: t.pageS.y + sdy };
  t.pageSC = { x: t.pageSC.x + sdx, y: t.pageSC.y + sdy };
  t.startPt = newStartPt;

  t.endCtrlPt = { x: t.endCtrlPt.x + edx, y: t.endCtrlPt.y + edy };
  t.pageE = { x: t.pageE.x + edx, y: t.pageE.y + edy };
  t.pageEC = { x: t.pageEC.x + edx, y: t.pageEC.y + edy };
  t.endPt = newEndPt;
}

// Seeds/re-docks a cross-page transition's connector geometry, porting
// StateTransitionObj.moveEndPts (cross-page branch) + DrawArea.getOffset.
// Called on genuine topology changes only - see translateCrossPage above for
// why a plain state move translates instead of re-docking here.
export function recomputeCrossPage(doc: FzmDocument, t: FzmTransition): void {
  const startState = doc.states.find((s) => s.name === t.startState);
  const endState = doc.states.find((s) => s.name === t.endState);
  if (!startState || !endState) return;

  const sOffset = crossPageOffset(doc, t, 'start');
  const eOffset = crossPageOffset(doc, t, 'end');

  let sBorderOffset = Math.trunc(sOffset / 20);
  if (sBorderOffset < 0) sBorderOffset += 36;
  if (sBorderOffset > 35) sBorderOffset -= 36;
  let eBorderOffset = -Math.trunc(eOffset / 20);
  if (eBorderOffset < -18) eBorderOffset += 36;
  if (eBorderOffset > 17) eBorderOffset -= 36;

  t.startStateIndex = sBorderOffset;
  t.startPt = getBorderPts(startState)[t.startStateIndex];
  t.startCtrlPt = { x: t.startPt.x + 20, y: t.startPt.y };

  t.endStateIndex = 18 + eBorderOffset;
  t.endPt = getBorderPts(endState)[t.endStateIndex];
  t.endCtrlPt = { x: t.endPt.x - 20, y: t.endPt.y };

  t.pageS = { x: doc.preferences.pageSizeW - 50, y: t.startPt.y + sOffset };
  t.pageSC = { x: doc.preferences.pageSizeW - 70, y: t.startPt.y + sOffset };
  t.pageE = { x: 50, y: t.endPt.y + eOffset };
  t.pageEC = { x: 70, y: t.endPt.y + eOffset };
}

// Ports DrawArea.updatePageConn: re-docks every cross-page connector, called
// on any page-size change (pageS/pageSC sit at pageSizeW-50/-70 - stale after
// a resize until some endpoint state happens to move). Java's companion
// moveOnResize (pulling states/text back onto a shrunk page) is deliberately
// NOT ported - clamping objects to the page was already skipped by design
// (NEXT_STEP.md round 2, STEP 10) so dragging/growing the canvas keeps working.
export function updatePageConnectors(doc: FzmDocument): void {
  const pageOf = new Map(doc.states.map((s) => [s.name, s.page]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') continue;
    const sp = pageOf.get(t.startState);
    const ep = pageOf.get(t.endState);
    if (sp !== undefined && ep !== undefined && sp !== ep) recomputeCrossPage(doc, t);
  }
}

// Ports DrawArea.pageConnUpdate: re-staggers every cross-page connector
// sharing a page-connector side with any of `stateNames` (getOffset's stagger
// is a rank-out-of-total among siblings on that side, so adding or removing
// one sibling shifts all the others - StateTransitionObj.initTrans calls this
// after wiring a new cross-page transition; deleting one needs the same
// refresh, which nothing previously did).
export function restaggerCrossPage(doc: FzmDocument, stateNames: Set<string> | string[]): void {
  const names = stateNames instanceof Set ? stateNames : new Set(stateNames);
  const pageOf = new Map(doc.states.map((s) => [s.name, s.page]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') continue;
    const sp = pageOf.get(t.startState);
    const ep = pageOf.get(t.endState);
    if (sp === undefined || ep === undefined || sp === ep) continue;
    if (names.has(t.startState) || names.has(t.endState)) recomputeCrossPage(doc, t);
  }
}
