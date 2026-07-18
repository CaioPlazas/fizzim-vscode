import { FzmDocument, FzmLoopback, FzmState, FzmTransition, Point } from '../fzm/model';

// Ports the geometry from StateObj.getBorderPts() and
// StateTransitionObj/LoopbackTransitionObj's setEndPts()/updateObj(). Scope
// note: StateTransitionObj also has a moveEndPts() "fast path" that preserves
// curve shape during small drags for visual smoothness (see recalcCheck() in
// the Java source) - we deliberately skip porting that and always do the full
// recompute below. It's a cosmetic optimization from the original Swing app's
// redraw performance, not something that affects the final result once a drag
// ends, and always-recompute is simpler to keep correct.

export function getBorderPts(s: FzmState): Point[] {
  const pts: Point[] = [];
  const w = s.x1 - s.x0;
  const h = s.y1 - s.y0;
  for (let i = 0; i < 36; i++) {
    const angle = ((2 * Math.PI) / 36) * i;
    pts.push({
      x: Math.trunc(s.x0 + w / 2 + (w / 2) * Math.cos(angle)),
      y: Math.trunc(s.y0 + h / 2 + (h / 2) * Math.sin(angle)),
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

function realCenter(s: FzmState): Point {
  return { x: s.x0 + (s.x1 - s.x0) / 2, y: s.y0 + (s.y1 - s.y0) / 2 };
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
export function createStubGeometry(state: FzmState): { startStateIndex: number; startPt: Point; pageS: Point } {
  const borderPts = getBorderPts(state);
  const startPt = borderPts[0];
  return { startStateIndex: 0, startPt, pageS: { x: startPt.x + 60, y: startPt.y } };
}

// Re-anchors a stub when its start state moves/resizes: startPt snaps back to
// its border point and the tip (pageS) follows, preserving the stub's length
// and outward angle (StateTransitionObj.moveEndPts, `stub` branch, which keeps
// the stored angle/len - we derive them from the current startPt->pageS vector,
// which holds the pre-move values when this runs).
export function recomputeStub(t: FzmTransition, startState: FzmState): void {
  const borderPts = getBorderPts(startState);
  const angle = getAngle(t.pageS, t.startPt);
  const len = Math.round(Math.hypot(t.pageS.x - t.startPt.x, t.pageS.y - t.startPt.y)) || 60;
  t.startPt = borderPts[t.startStateIndex] ?? borderPts[0];
  t.pageS = { x: Math.trunc(t.startPt.x + len * Math.cos(angle)), y: Math.trunc(t.startPt.y - len * Math.sin(angle)) };
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

// Seeds/re-docks a cross-page transition's connector geometry, porting
// StateTransitionObj.moveEndPts (cross-page branch) + DrawArea.getOffset.
// Java re-runs this whenever an endpoint state moves or changes page, so a
// hand-dragged connector re-docks to the page edge on state move — that is
// faithful, keep it.
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
