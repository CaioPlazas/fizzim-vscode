import { FzmDocument, FzmLoopback, FzmState, FzmTransition, Point } from '../fzm/model';
import { pentagonOrigin, sameStub, textBounds, transitionOnPage } from './render';

function distToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export type Selection =
  | { kind: 'state'; index: number }
  | { kind: 'transition'; index: number }
  | { kind: 'text'; index: number };

const CURVE_HIT_WIDTH = 10; // matches StateTransitionObj's 10px stroked-shape hit test

export function pointInEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Normalize two corner points into a rect with x0<=x1, y0<=y1.
export function normRect(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

// Selectable objects (states + free text, matching Java's rubber-band which
// ignores transitions) fully contained in the box, on the given page.
export function objectsInBox(doc: FzmDocument, page: number, r: Rect): Selection[] {
  const out: Selection[] = [];
  doc.states.forEach((s, i) => {
    if (s.page === page && s.x0 >= r.x0 && s.y0 >= r.y0 && s.x1 <= r.x1 && s.y1 <= r.y1) {
      out.push({ kind: 'state', index: i });
    }
  });
  doc.texts.forEach((t, i) => {
    if (!t.isGlobalTable && t.page === page && t.x >= r.x0 && t.x <= r.x1 && t.y >= r.y0 && t.y <= r.y1) {
      out.push({ kind: 'text', index: i });
    }
  });
  return out;
}

// Which corner resize-handle of a state is at (x, y), if any. Handles are the
// 4 corners of the state's bounding box (drawn as red squares when selected).
export type StateHandle = 'tl' | 'tr' | 'bl' | 'br';
export function stateHandleAt(s: FzmState, x: number, y: number, tol: number): StateHandle | null {
  const near = (hx: number, hy: number) => Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol;
  if (near(s.x0, s.y0)) return 'tl';
  if (near(s.x1, s.y0)) return 'tr';
  if (near(s.x0, s.y1)) return 'bl';
  if (near(s.x1, s.y1)) return 'br';
  return null;
}

// Which drag-handle of a selected transition/loopback is at (x, y), if any:
// the two endpoints (which re-snap to a state border) and the two bezier
// control points (which move freely).
function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, s: number): Point {
  const mt = 1 - s;
  const a = mt * mt * mt, b = 3 * mt * mt * s, c = 3 * mt * s * s, d = s * s * s;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// Which side of a cross-page transition is drawn on `page` (null if neither).
export function crossPageSide(doc: FzmDocument, t: FzmTransition, page: number): 'source' | 'dest' | null {
  const pageOf = (n: string) => doc.states.find((s) => s.name === n)?.page;
  if (pageOf(t.startState) === page) return 'source';
  if (pageOf(t.endState) === page) return 'dest';
  return null;
}

// The four bezier points a cross-page transition draws on a side — must match
// drawCrossPageStub: source runs state -> page edge, dest runs page edge -> state.
export function crossPageCurve(t: FzmTransition, side: 'source' | 'dest'): [Point, Point, Point, Point] {
  return side === 'source'
    ? [t.startPt, t.startCtrlPt, t.pageSC, t.pageS]
    : [t.pageE, t.pageEC, t.endCtrlPt, t.endPt];
}

// A cross-page transition is hit on `page` when the point is near that side's
// bezier or inside its pentagon connector. Pure (no canvas) so it's unit-testable.
export function crossPageHit(doc: FzmDocument, t: FzmTransition, page: number, x: number, y: number): boolean {
  const side = crossPageSide(doc, t, page);
  if (!side) return false;
  const [p0, p1, p2, p3] = crossPageCurve(t, side);
  const STEPS = 20;
  let prev = bezierPoint(p0, p1, p2, p3, 0);
  for (let i = 1; i <= STEPS; i++) {
    const cur = bezierPoint(p0, p1, p2, p3, i / STEPS);
    if (distToSegment(x, y, prev, cur) <= CURVE_HIT_WIDTH / 2) return true;
    prev = cur;
  }
  const o = pentagonOrigin(t, side);
  return x >= o.x && x <= o.x + 40 && y >= o.y - 10 && y <= o.y + 10;
}

export type CurveHandle = 'start' | 'end' | 'startCtrl' | 'endCtrl' | 'stubTip' | 'pageS' | 'pageSC' | 'pageE' | 'pageEC';
export function transitionHandleAt(
  t: FzmTransition | FzmLoopback,
  x: number,
  y: number,
  tol: number,
  crossSide?: 'source' | 'dest' | null
): CurveHandle | null {
  const near = (hx: number, hy: number) => Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol;
  // A cross-page transition exposes only the four handles drawn on this page.
  if (t.kind === 'transition' && crossSide) {
    if (crossSide === 'source') {
      if (near(t.pageS.x, t.pageS.y)) return 'pageS';
      if (near(t.pageSC.x, t.pageSC.y)) return 'pageSC';
      if (near(t.startCtrlPt.x, t.startCtrlPt.y)) return 'startCtrl';
      if (near(t.startPt.x, t.startPt.y)) return 'start';
      return null;
    }
    if (near(t.pageE.x, t.pageE.y)) return 'pageE';
    if (near(t.pageEC.x, t.pageEC.y)) return 'pageEC';
    if (near(t.endCtrlPt.x, t.endCtrlPt.y)) return 'endCtrl';
    if (near(t.endPt.x, t.endPt.y)) return 'end';
    return null;
  }
  // A stub only exposes its anchor (re-snaps to the border) and its tip.
  if (t.kind === 'transition' && t.stub) {
    if (near(t.pageS.x, t.pageS.y)) return 'stubTip';
    if (near(t.startPt.x, t.startPt.y)) return 'start';
    return null;
  }
  if (near(t.startCtrlPt.x, t.startCtrlPt.y)) return 'startCtrl';
  if (near(t.endCtrlPt.x, t.endCtrlPt.y)) return 'endCtrl';
  if (near(t.startPt.x, t.startPt.y)) return 'start';
  if (near(t.endPt.x, t.endPt.y)) return 'end';
  return null;
}

export function hitTest(ctx: CanvasRenderingContext2D, doc: FzmDocument, page: number, x: number, y: number): Selection | null {
  for (let i = doc.texts.length - 1; i >= 0; i--) {
    const t = doc.texts[i];
    if (t.isGlobalTable || t.page !== page) continue;
    const b = textBounds(ctx, t.text ?? '', t.x, t.y);
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      return { kind: 'text', index: i };
    }
  }

  const statePage = new Map(doc.states.map((s) => [s.name, s.page]));
  for (let i = doc.transitions.length - 1; i >= 0; i--) {
    const t = doc.transitions[i];
    if (transitionOnPage(doc, t, page)) {
      // A same-page stub is a short segment (startPt -> pageS), not the curve.
      if (t.kind === 'transition' && t.stub) {
        const { pt, tip } = sameStub(t);
        if (distToSegment(x, y, pt, tip) <= CURVE_HIT_WIDTH / 2) return { kind: 'transition', index: i };
        continue;
      }
      const path = new Path2D();
      path.moveTo(t.startPt.x, t.startPt.y);
      path.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
      ctx.lineWidth = CURVE_HIT_WIDTH;
      if (ctx.isPointInStroke(path, x, y)) return { kind: 'transition', index: i };
    } else if (t.kind === 'transition') {
      // Cross-page: hit-test this page's bezier + pentagon connector.
      if (crossPageHit(doc, t, page, x, y)) return { kind: 'transition', index: i };
    }
  }

  for (let i = doc.states.length - 1; i >= 0; i--) {
    const s = doc.states[i];
    if (s.page !== page) continue;
    const rx = (s.x1 - s.x0) / 2;
    const ry = (s.y1 - s.y0) / 2;
    const cx = s.x0 + rx;
    const cy = s.y0 + ry;
    if (pointInEllipse(x, y, cx, cy, rx, ry)) {
      return { kind: 'state', index: i };
    }
  }

  return null;
}
