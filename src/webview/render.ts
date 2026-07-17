import { FzmDocument, FzmLoopback, FzmState, FzmTransition, ObjAttribute, Point } from '../fzm/model';
import type { Selection } from './hitTest';

const RESET_RING_OFFSET = 3;
const ARROW_LENGTH = 13;
const ARROW_ANGLE = Math.PI / 6; // 30 degrees, matches StateTransitionObj's arrowhead
const HANDLE_SIZE = 7;

export let TEXT_FONT = '11px Arial';
// Canvas fillText draws from the alphabetic baseline: glyphs extend up by the
// ascent and down by the descent. These bounds are shared by rendering,
// hit-testing, and the selection box so they can't drift apart.
const TEXT_ASCENT = 11;
const TEXT_DESCENT = 3;
// Vertical step between stacked attribute labels (Java uses the font height).
const TEXT_LINE_H = TEXT_ASCENT + TEXT_DESCENT;

// Bounding box of a text object, given its stored (x, y) baseline anchor.
// Splits on literal backslash+n (the two characters Java writes in .fzm files)
// and covers all lines; when there is no \n the result is identical to the
// single-line version (existing tests must keep passing).
export function textBounds(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): { x: number; y: number; width: number; height: number } {
  ctx.font = TEXT_FONT;
  const lines = text.split('\\n');
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  return { x, y: y - TEXT_ASCENT, width: maxW, height: TEXT_ASCENT + TEXT_DESCENT + (lines.length - 1) * TEXT_LINE_H };
}

function colorToCss(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

// Theme + view state used while drawing. Set by render() each frame from the
// webview's current VS Code theme colors and zoom level. Kept as module state
// so the draw helpers don't each need extra params.
let themeFg = '#000000';
let themeBg = '#ffffff';
let lineW = 1;
const DEFAULT_BLACK = -16777216;

export interface RenderOptions {
  zoom: number;
  fg: string;
  bg: string;
  fontPx?: number;
  fontName?: string;
  lineWidth?: number;
  showTable?: boolean;
  // The attribute label currently being dragged: `selection` is null during a
  // label drag, so this is how the red box stays visible while you move it.
  dragLabel?: AttrLabelTarget;
  group?: Selection[];
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
}

// The color to actually draw an object with: its stored color, except the
// default black is swapped for the theme foreground so black shapes stay
// visible on a dark background.
function resolveColor(rgb: number): string {
  return rgb === DEFAULT_BLACK ? themeFg : colorToCss(rgb);
}

// A row of the on-canvas global-attributes table (Name/Value/Type/Comment).
export interface TableRow {
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  header: boolean;
}

// Ports TextObj.updateGlobalText: one section per global list, skipping empty
// ones (states/transitions need >1 to be worth showing) and the reserved
// "name" row of the states/transitions lists. "reg" is shown as "statebit".
export function buildGlobalTableRows(doc: FzmDocument): TableRow[] {
  const sections = [
    { title: 'STATE MACHINE', list: doc.machine, min: 1, skipFirst: false },
    { title: 'INPUTS', list: doc.inputs, min: 1, skipFirst: false },
    { title: 'OUTPUTS', list: doc.outputs, min: 1, skipFirst: false },
    { title: 'STATES', list: doc.stateAttrs, min: 2, skipFirst: true },
    { title: 'TRANSITIONS', list: doc.transAttrs, min: 2, skipFirst: true },
  ];
  const rows: TableRow[] = [];
  for (const { title, list, min, skipFirst } of sections) {
    if (list.length < min) continue;
    rows.push({ c1: title, c2: '', c3: '', c4: '', header: true });
    list.forEach((a, j) => {
      if (skipFirst && j === 0) return;
      const type = a.type === 'reg' ? 'statebit' : a.type;
      rows.push({ c1: `   ${a.name}`, c2: a.value, c3: type, c4: a.comment, header: false });
    });
  }
  return rows;
}

// Per-output info needed for labels: its assignment operator (registered/flag
// outputs use "<=", combinational use "=") and default value (to decide whether
// a "non-default" attribute should show).
export type OutputInfo = Map<string, { op: string; def: string }>;

// A transition is visible on a page only when both its endpoint states are on
// that page (loopbacks: their single state). Shared by render and hit-testing.
export function transitionOnPage(doc: FzmDocument, t: FzmTransition | FzmLoopback, page: number): boolean {
  const pageOf = (name: string) => doc.states.find((s) => s.name === name)?.page;
  if (t.kind === 'loopback') return pageOf(t.state) === page;
  return pageOf(t.startState) === page && pageOf(t.endState) === page;
}

export function buildOutputInfo(outputs: ObjAttribute[]): OutputInfo {
  const map: OutputInfo = new Map();
  for (const o of outputs) {
    const op = o.type === 'reg' || o.type === 'regdp' || o.type === 'flag' ? '<=' : '=';
    map.set(o.name, { op, def: o.value });
  }
  return map;
}

// Whether an attribute is drawn on the canvas. Ports ObjAttribute.getVisible():
// visibility 1 (YES) always shows; visibility 2 (only-non-default) shows only
// when the value is a local override (valueStatus LOCAL), matching Java's
// `editable[1] == LOCAL` test. Visibility 0 (NO) never shows.
export function attrIsVisible(a: ObjAttribute): boolean {
  if (a.visibility === 1) return true;
  return a.visibility === 2 && a.valueStatus === 'LOCAL';
}

// The text drawn for a visible attribute. Ports ObjAttribute.paintComponent:
// "name" and "equation" show just the value; registered/flag outputs use "<=";
// everything else (comb outputs, priority, user attrs, …) shows "name = value".
export function attrLabelText(a: ObjAttribute, info: OutputInfo): string {
  if (a.name === 'name' || a.name === 'equation') return a.value;
  const op = info.get(a.name)?.op ?? '=';
  return `${a.name} ${op} ${a.value}`;
}

export interface AttrLabel {
  attr: ObjAttribute;
  text: string;
  index: number; // position in the object's own attribute list (for mutation)
}

// The visible attributes of an object, in list order, as positioned labels.
// The array position is Fizzim's `step` (visible-only stacking); `index` is the
// attribute's original position in the list.
export function visibleAttrLabels(attributes: ObjAttribute[], info: OutputInfo): AttrLabel[] {
  const out: AttrLabel[] = [];
  attributes.forEach((a, index) => {
    if (attrIsVisible(a)) out.push({ attr: a, text: attrLabelText(a, info), index });
  });
  return out;
}

// A state's text anchor: horizontally centered, one quarter down the ellipse
// (StateObj.getCenter uses y0 + h/4). Visible attributes stack down from here.
export function stateAnchor(s: FzmState): Point {
  return { x: s.x0 + (s.x1 - s.x0) / 2, y: s.y0 + (s.y1 - s.y0) / 4 };
}

// Draws an object's visible attribute labels, each centered on
// anchor + (x2Obj, y2Obj) and stacked by its visible index (Java's `step`).
// Ports GeneralObj.paintComponent's attribute loop + ObjAttribute.paintComponent.
function drawAttrLabels(ctx: CanvasRenderingContext2D, attributes: ObjAttribute[], info: OutputInfo, anchor: Point, filterPage?: number): void {
  ctx.font = TEXT_FONT;
  ctx.textAlign = 'center';
  visibleAttrLabels(attributes, info).forEach((lab, step) => {
    // On a cross-page transition each label lives on its own page (Java's
    // ObjAttribute.paintComponent `myPage == currPage`), but `step` still counts
    // every visible attribute so the stacking positions stay stable.
    if (filterPage !== undefined && lab.attr.page !== filterPage) return;
    ctx.fillStyle = resolveColor(lab.attr.color);
    const cx = anchor.x + lab.attr.x2Obj;
    const baseY = anchor.y + step * TEXT_LINE_H + lab.attr.y2Obj;
    // Literal "\n" in an attribute value splits into multiple stacked lines.
    lab.text.split('\\n').forEach((line, li) => ctx.fillText(line, cx, baseY + li * TEXT_LINE_H));
  });
}

// A hit on an object's individual attribute label. `attrIndex` is the index
// into the object's own attribute list (so a drag can mutate the right one).
export interface AttrLabelTarget {
  kind: 'state' | 'transition';
  index: number;
  attrIndex: number;
}

// The bounding box of a visible label, mirroring drawAttrLabels' layout and
// ObjAttribute's selection box. Needs the canvas to measure text width.
function labelBox(ctx: CanvasRenderingContext2D, lab: AttrLabel, anchor: Point, step: number): { l: number; r: number; t: number; b: number } {
  const cx = anchor.x + lab.attr.x2Obj;
  const baseY = anchor.y + step * TEXT_LINE_H + lab.attr.y2Obj;
  const lines = lab.text.split('\\n');
  let tW = 0;
  for (const line of lines) tW = Math.max(tW, ctx.measureText(line).width);
  const yoffset = (lines.length - 1) * TEXT_LINE_H;
  return { l: cx - tW / 2 - 4, r: cx + tW / 2 + 4, t: baseY - TEXT_ASCENT, b: baseY + TEXT_DESCENT + yoffset };
}

// Red outlines around an object's visible labels (Java's parentSelected /
// selected-label box). filterPage as in drawAttrLabels.
export function drawLabelBoxes(ctx: CanvasRenderingContext2D, attributes: ObjAttribute[], info: OutputInfo, anchor: Point, filterPage?: number): void {
  ctx.font = TEXT_FONT;
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1;
  visibleAttrLabels(attributes, info).forEach((lab, step) => {
    if (filterPage !== undefined && lab.attr.page !== filterPage) return;
    const b = labelBox(ctx, lab, anchor, step);
    ctx.strokeRect(b.l, b.t, b.r - b.l, b.b - b.t);
  });
}

// Index (into `attributes`) of the topmost visible label under (x, y), or -1.
function labelHitIn(ctx: CanvasRenderingContext2D, attributes: ObjAttribute[], info: OutputInfo, anchor: Point, x: number, y: number, filterPage?: number): number {
  const labels = visibleAttrLabels(attributes, info);
  for (let k = labels.length - 1; k >= 0; k--) {
    if (filterPage !== undefined && labels[k].attr.page !== filterPage) continue;
    const box = labelBox(ctx, labels[k], anchor, k);
    if (x >= box.l && x <= box.r && y >= box.t && y <= box.b) return labels[k].index;
  }
  return -1;
}

// The visible attribute label under (x, y), if any. Checked before shape hits
// (Java tests attribute text first): transitions on top of states, later-drawn
// objects on top. Returns which object + which of its attributes was hit.
export function hitAttrLabel(ctx: CanvasRenderingContext2D, doc: FzmDocument, page: number, x: number, y: number): AttrLabelTarget | null {
  ctx.font = TEXT_FONT;
  const info = buildOutputInfo(doc.outputs);
  const pageOf = (name: string) => doc.states.find((s) => s.name === name)?.page;
  for (let i = doc.transitions.length - 1; i >= 0; i--) {
    const t = doc.transitions[i];
    const sp = t.kind === 'loopback' ? pageOf(t.state) : pageOf(t.startState);
    const ep = t.kind === 'loopback' ? pageOf(t.state) : pageOf(t.endState);
    const onPage = sp === page || ep === page;
    if (!onPage) continue;
    // Same-page transition: hit any label; cross-page: only labels on this page.
    const filterPage = sp === page && ep === page ? undefined : page;
    const attrIndex = labelHitIn(ctx, t.attributes, info, transitionLabelAnchor(t, doc, page), x, y, filterPage);
    if (attrIndex >= 0) return { kind: 'transition', index: i, attrIndex };
  }
  for (let i = doc.states.length - 1; i >= 0; i--) {
    const s = doc.states[i];
    if (s.page !== page) continue;
    const attrIndex = labelHitIn(ctx, s.attributes, info, stateAnchor(s), x, y);
    if (attrIndex >= 0) return { kind: 'state', index: i, attrIndex };
  }
  return null;
}

function drawState(ctx: CanvasRenderingContext2D, s: FzmState): void {
  const rx = (s.x1 - s.x0) / 2;
  const ry = (s.y1 - s.y0) / 2;
  const cx = s.x0 + rx;
  const cy = s.y0 + ry;

  ctx.strokeStyle = resolveColor(s.color);
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  if (s.reset) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + RESET_RING_OFFSET, ry + RESET_RING_OFFSET, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGlobalTable(ctx: CanvasRenderingContext2D, doc: FzmDocument, x: number, y: number): void {
  const rows = buildGlobalTableRows(doc);
  if (rows.length === 0) return;
  ctx.font = TEXT_FONT;
  ctx.textAlign = 'left';
  ctx.fillStyle = themeFg;

  const lineH = 15;
  // Column x-offsets from the measured widest cell in each column.
  const w1 = Math.max(...rows.map((r) => ctx.measureText(r.c1).width));
  const w2 = Math.max(...rows.map((r) => ctx.measureText(r.c2).width));
  const w3 = Math.max(...rows.map((r) => ctx.measureText(r.c3).width));
  const pad = 16;
  const x1 = x;
  const x2 = x1 + w1 + pad;
  const x3 = x2 + w2 + pad;
  const x4 = x3 + w3 + pad;

  rows.forEach((r, i) => {
    const ry = y + (i + 1) * lineH;
    ctx.fillText(r.c1, x1, ry);
    if (!r.header) {
      ctx.fillText(r.c2, x2, ry);
      ctx.fillText(r.c3, x3, ry);
      ctx.fillText(r.c4, x4, ry);
    }
  });
}

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const x1 = to.x - ARROW_LENGTH * Math.cos(angle - ARROW_ANGLE);
  const y1 = to.y - ARROW_LENGTH * Math.sin(angle - ARROW_ANGLE);
  const x2 = to.x - ARROW_LENGTH * Math.cos(angle + ARROW_ANGLE);
  const y2 = to.y - ARROW_LENGTH * Math.sin(angle + ARROW_ANGLE);

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.fill();
}

// A page-connector "stub" for a cross-page transition, drawn on the page that
// holds one of its endpoints. Shows a short arrow out of (source) / into (dest)
// the on-page state, tipped with a small marker and labelled with the other
// state and its page — so the cross-page link is visible without the full curve.
// The stub line segment (endpoint -> tip) for a cross-page transition on the
// page holding `side`'s state, or null if that state isn't found. Shared by
// rendering and hit-testing.

// The pentagon "road sign" Java stamps at a page connector: a 40x20 box with a
// point on its right edge, drawn with its left edge at (x, y).
// (x,y) -> (x,y+10) -> (x+30,y+10) -> (x+40,y) -> (x+30,y-10) -> (x,y-10) -> (x,y)
export function pentagonPath(x: number, y: number): Point[] {
  return [
    { x, y },
    { x, y: y + 10 },
    { x: x + 30, y: y + 10 },
    { x: x + 40, y },
    { x: x + 30, y: y - 10 },
    { x, y: y - 10 },
    { x, y },
  ];
}

// The pentagon's left-edge x for a given side (the dest sign sits to the LEFT of
// pageE so its point aims into the page). Shared by render and hit-testing.
export function pentagonOrigin(t: FzmTransition, side: 'source' | 'dest'): Point {
  return side === 'source' ? { x: t.pageS.x, y: t.pageS.y } : { x: t.pageE.x - 40, y: t.pageE.y };
}

// A cross-page transition, drawn on one of its two pages: the bezier that runs
// off to the page edge plus the pentagon connector and its "state (page)" label
// (StateTransitionObj's "draw page connector" block).
function drawCrossPageStub(
  ctx: CanvasRenderingContext2D,
  doc: FzmDocument,
  t: FzmTransition,
  side: 'source' | 'dest'
): void {
  const otherName = side === 'source' ? t.endState : t.startState;
  const otherState = doc.states.find((s) => s.name === otherName);

  ctx.strokeStyle = resolveColor(t.color);
  ctx.fillStyle = resolveColor(t.color);
  ctx.lineWidth = lineW;

  ctx.beginPath();
  if (side === 'source') {
    // startPt -> startCtrlPt -> pageSC -> pageS
    ctx.moveTo(t.startPt.x, t.startPt.y);
    ctx.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.pageSC.x, t.pageSC.y, t.pageS.x, t.pageS.y);
  } else {
    // pageE -> pageEC -> endCtrlPt -> endPt
    ctx.moveTo(t.pageE.x, t.pageE.y);
    ctx.bezierCurveTo(t.pageEC.x, t.pageEC.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
  }
  ctx.stroke();
  // Java draws the endpoint arrowhead on the destination page only.
  if (side === 'dest') drawArrowhead(ctx, t.endCtrlPt, t.endPt);

  const o = pentagonOrigin(t, side);
  const pts = pentagonPath(o.x, o.y);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();

  const otherPageName = otherState ? doc.tabs[otherState.page - 1] ?? `Page ${otherState.page}` : '?';
  const label = `${otherName} (${otherPageName})`;
  ctx.fillStyle = themeFg;
  ctx.font = TEXT_FONT;
  ctx.textAlign = 'left';
  // Java right-aligns a label wider than the sign to the pentagon's right edge.
  const w = ctx.measureText(label).width;
  ctx.fillText(label, w > 40 ? o.x + 40 - w : o.x, o.y + 25);
}

// A same-page "stub" transition (Fizzim's TransProperties "Stub?"): instead of
// a curve to the end state, draw a short arrow out of the start state, tipped
// and labelled with the destination state's name. Geometry: startPt (on the
// border) -> pageS (the tip). Shared by rendering and hit-testing.
export function sameStub(t: FzmTransition): { pt: Point; tip: Point } {
  return { pt: t.startPt, tip: t.pageS };
}

function drawSameStub(ctx: CanvasRenderingContext2D, t: FzmTransition): void {
  const { pt, tip } = sameStub(t);
  ctx.strokeStyle = resolveColor(t.color);
  ctx.fillStyle = resolveColor(t.color);
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  // Open "V" chevron at the tip, matching Java (StateTransitionObj draws two
  // lines, not a filled triangle). Java's angle has y inverted: the stub tip is
  // startPt + len*(cos, -sin), so sin = -(tip.y - pt.y)/len.
  const dx = tip.x - pt.x, dy = tip.y - pt.y;
  const len = Math.hypot(dx, dy) || 1;
  const cos = dx / len, sin = -dy / len;
  ctx.beginPath();
  ctx.moveTo(tip.x - (6 * sin + 7 * cos), tip.y - (6 * cos - 7 * sin));
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x + (6 * sin - 7 * cos), tip.y + (6 * cos + 7 * sin));
  ctx.stroke();

  // Label the tip with the destination state's name (Java draws endState name).
  ctx.fillStyle = themeFg;
  ctx.font = TEXT_FONT;
  ctx.textAlign = dx >= 0 ? 'left' : 'right';
  ctx.fillText(t.endState, tip.x + (dx >= 0 ? 4 : -4), tip.y - 4);
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// A same-page transition's text anchor is the midpoint of its endpoints
// (StateTransitionObj.getCenter); a loopback's is the midpoint of its control
// points (a practical stand-in for Java's border-index computation).
export function curveAnchor(t: FzmTransition | FzmLoopback): Point {
  return t.kind === 'loopback' ? midpoint(t.startCtrlPt, t.endCtrlPt) : midpoint(t.startPt, t.endPt);
}

// The text anchor for a transition/loopback's labels on the given page. Same
// per-case choice the render loop and hit-testing both use, so they line up:
// same-page = endpoint midpoint (stub = anchor→tip midpoint), cross-page = the
// midpoint of whichever on-page stub segment is showing.
export function transitionLabelAnchor(t: FzmTransition | FzmLoopback, doc: FzmDocument, page: number): Point {
  if (t.kind === 'loopback') return curveAnchor(t);
  const sp = doc.states.find((s) => s.name === t.startState)?.page;
  const ep = doc.states.find((s) => s.name === t.endState)?.page;
  if (sp === ep) return t.stub ? midpoint(t.startPt, t.pageS) : midpoint(t.startPt, t.endPt);
  return page === sp ? midpoint(t.startPt, t.pageS) : midpoint(t.endPt, t.pageE);
}

function drawCurve(ctx: CanvasRenderingContext2D, t: FzmTransition | FzmLoopback): void {
  ctx.strokeStyle = resolveColor(t.color);
  ctx.fillStyle = resolveColor(t.color);
  ctx.lineWidth = lineW;

  ctx.beginPath();
  ctx.moveTo(t.startPt.x, t.startPt.y);
  ctx.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
  ctx.stroke();

  drawArrowhead(ctx, t.endCtrlPt, t.endPt);
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
}

function drawStateSelection(ctx: CanvasRenderingContext2D, s: FzmState): void {
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  drawHandle(ctx, s.x0, s.y0);
  drawHandle(ctx, s.x1, s.y0);
  drawHandle(ctx, s.x0, s.y1);
  drawHandle(ctx, s.x1, s.y1);
}

function drawCurveSelection(ctx: CanvasRenderingContext2D, t: FzmTransition | FzmLoopback): void {
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(t.startPt.x, t.startPt.y);
  ctx.lineTo(t.startCtrlPt.x, t.startCtrlPt.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(t.endPt.x, t.endPt.y);
  ctx.lineTo(t.endCtrlPt.x, t.endCtrlPt.y);
  ctx.stroke();

  drawHandle(ctx, t.startPt.x, t.startPt.y);
  drawHandle(ctx, t.endPt.x, t.endPt.y);
  drawHandle(ctx, t.startCtrlPt.x, t.startCtrlPt.y);
  drawHandle(ctx, t.endCtrlPt.x, t.endCtrlPt.y);
}

function drawStubSelection(ctx: CanvasRenderingContext2D, t: FzmTransition): void {
  const { pt, tip } = sameStub(t);
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  drawHandle(ctx, pt.x, pt.y);
  drawHandle(ctx, tip.x, tip.y);
}

function drawTextSelection(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const b = textBounds(ctx, text, x, y);
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x, b.y, b.width, b.height);
}

export function render(
  ctx: CanvasRenderingContext2D,
  doc: FzmDocument,
  page: number,
  selection: Selection | null,
  opts: RenderOptions = { zoom: 1, fg: '#000000', bg: '#ffffff' }
): void {
  themeFg = opts.fg;
  themeBg = opts.bg;
  TEXT_FONT = `${opts.fontPx ?? 11}px ${(opts.fontName && opts.fontName.trim()) || 'Arial'}`;
  lineW = opts.lineWidth ?? 1;
  const canvas = ctx.canvas;

  // Paint the theme background over the whole (device-pixel) canvas, then draw
  // everything in model coordinates scaled by the zoom factor.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = themeBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(opts.zoom, 0, 0, opts.zoom, 0, 0);

  // Alignment grid (when enabled in the .fzm), drawn faintly behind everything.
  if (doc.preferences.grid && doc.preferences.gridSize > 0) {
    const g = doc.preferences.gridSize;
    const w = canvas.width / opts.zoom;
    const h = canvas.height / opts.zoom;
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = themeFg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= w; gx += g) {
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
    }
    for (let gy = 0; gy <= h; gy += g) {
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
    }
    ctx.stroke();
    ctx.restore();
  }

  const outputInfo = buildOutputInfo(doc.outputs);
  for (const s of doc.states) {
    if (s.page === page) {
      drawState(ctx, s);
      // Name + visible outputs/attributes, each independently positioned & movable.
      drawAttrLabels(ctx, s.attributes, outputInfo, stateAnchor(s));
    }
  }
  // A transition is drawn in full only when both endpoint states are on this
  // page. If exactly one endpoint is on the page, draw a page-connector "stub"
  // instead (like Fizzim), so the cross-page link is visible.
  const statePage = new Map(doc.states.map((s) => [s.name, s.page]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') {
      if (statePage.get(t.state) === page) {
        drawCurve(ctx, t);
        drawAttrLabels(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page));
      }
      continue;
    }
    const sp = statePage.get(t.startState);
    const ep = statePage.get(t.endState);
    if (sp === page && ep === page) {
      if (t.stub) drawSameStub(ctx, t);
      else drawCurve(ctx, t);
      // Same-page: all labels draw here, regardless of their stored page.
      drawAttrLabels(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page));
    } else if (sp === page) {
      drawCrossPageStub(ctx, doc, t, 'source');
      // Cross-page: only the labels assigned to this page (Java's per-attribute
      // page); the rest show on the other endpoint's page.
      drawAttrLabels(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page), page);
    } else if (ep === page) {
      drawCrossPageStub(ctx, doc, t, 'dest');
      drawAttrLabels(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page), page);
    }
  }
  for (const txt of doc.texts) {
    if (txt.page !== page) continue;
    if (txt.isGlobalTable) {
      if (opts.showTable !== false) drawGlobalTable(ctx, doc, txt.x, txt.y);
      continue;
    }
    ctx.fillStyle = themeFg;
    ctx.font = TEXT_FONT;
    ctx.textAlign = 'left';
    (txt.text ?? '').split('\\n').forEach((line, li) => ctx.fillText(line, txt.x, txt.y + li * TEXT_LINE_H));
  }

  // A label being dragged keeps its red box even though nothing is "selected".
  if (opts.dragLabel) {
    const d = opts.dragLabel;
    if (d.kind === 'state') {
      const s = doc.states[d.index];
      if (s) drawLabelBoxes(ctx, s.attributes, outputInfo, stateAnchor(s));
    } else {
      const t = doc.transitions[d.index];
      if (t) {
        const fp = t.kind === 'transition' && !transitionOnPage(doc, t, page) ? page : undefined;
        drawLabelBoxes(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page), fp);
      }
    }
  }

  if (selection) {
    if (selection.kind === 'state') {
      const s = doc.states[selection.index];
      drawStateSelection(ctx, s);
      // Java boxes every label of a selected object (ObjAttribute parentSelected).
      drawLabelBoxes(ctx, s.attributes, outputInfo, stateAnchor(s));
    } else if (selection.kind === 'transition') {
      const t = doc.transitions[selection.index];
      // Equation / priority / any visible label of the selected transition.
      const fp = t.kind === 'transition' && !transitionOnPage(doc, t, page) ? page : undefined;
      drawLabelBoxes(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page), fp);
      if (t.kind === 'transition' && !transitionOnPage(doc, t, page)) {
        // Cross-page: this page's four handles + guide lines (Java's paint).
        const side = statePage.get(t.startState) === page ? 'source' : 'dest';
        const [anchor, anchorCtrl, edgeCtrl, edge] =
          side === 'source'
            ? [t.startPt, t.startCtrlPt, t.pageSC, t.pageS]
            : [t.endPt, t.endCtrlPt, t.pageEC, t.pageE];
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(anchorCtrl.x, anchorCtrl.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(edge.x, edge.y);
        ctx.lineTo(edgeCtrl.x, edgeCtrl.y);
        ctx.stroke();
        for (const p of [anchor, anchorCtrl, edgeCtrl, edge]) drawHandle(ctx, p.x, p.y);
      } else if (t.kind === 'transition' && t.stub) {
        drawStubSelection(ctx, t);
      } else {
        drawCurveSelection(ctx, t);
      }
    } else if (selection.kind === 'text') {
      const txt = doc.texts[selection.index];
      drawTextSelection(ctx, txt.text ?? '', txt.x, txt.y);
    }
  }

  // Multi-selection: a plain red outline around each grouped object.
  if (opts.group && opts.group.length) {
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1;
    for (const sel of opts.group) {
      if (sel.kind === 'state') {
        const s = doc.states[sel.index];
        ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
      } else if (sel.kind === 'text') {
        const t = doc.texts[sel.index];
        const b = textBounds(ctx, t.text ?? '', t.x, t.y);
        ctx.strokeRect(b.x, b.y, b.width, b.height);
      }
    }
  }

  // The rubber-band box being dragged.
  if (opts.marquee) {
    const m = opts.marquee;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.setLineDash([]);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// The content extent for a page, in model coordinates. Includes states,
// transition curve control points, and free text — plus the document's page
// size (from preferences) as a floor — so a large FSM is never clipped. The
// returned size is unscaled (the caller multiplies by the zoom factor).
// floorToPage=true (the canvas/scroll size) never shrinks below the current
// page size, so the drawing surface stays at least as big as Page Setup.
// floorToPage=false (used by "Fit Page") measures the content alone, ignoring
// the current page size — otherwise feeding the result back into pageSize would
// ratchet the page up by the +50 margin on every click.
export function computeBounds(
  doc: FzmDocument,
  page: number,
  floorToPage = true,
): { width: number; height: number } {
  // Floor at the .fzm page size (Fizzim's Page Setup), else a sensible minimum.
  let maxX = floorToPage ? Math.max(400, doc.preferences.pageSizeW) : 0;
  let maxY = floorToPage ? Math.max(300, doc.preferences.pageSizeH) : 0;

  for (const s of doc.states) {
    if (s.page !== page) continue;
    maxX = Math.max(maxX, s.x1);
    maxY = Math.max(maxY, s.y1);
  }
  for (const t of doc.transitions) {
    if (t.page !== page) continue;
    for (const p of [t.startPt, t.endPt, t.startCtrlPt, t.endCtrlPt]) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  for (const txt of doc.texts) {
    if (txt.page !== page) continue;
    maxX = Math.max(maxX, txt.x + 100);
    maxY = Math.max(maxY, txt.y);
  }
  return { width: maxX + 50, height: maxY + 50 };
}
