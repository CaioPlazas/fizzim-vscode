import { FzmDocument, FzmLoopback, FzmState, FzmTransition, ObjAttribute, Point } from '../fzm/model';
import type { Selection } from './hitTest';
import { makeTheme, Theme } from './theme';

const RESET_RING_OFFSET = 4;
// Grid dot size, in CSS pixels (converted to model units at draw time).
const GRID_DOT_PX = 1.5;
const ARROW_LENGTH = 13;
const ARROW_ANGLE = Math.PI / 6; // 30 degrees, matches StateTransitionObj's arrowhead
const HANDLE_SIZE = 7;
// HANDLE_SIZE in model units at the current zoom, i.e. always 7 screen px.
export function handleSize(): number {
  return HANDLE_SIZE / renderZoom;
}

// The zoom the canvas was last drawn at. hitTest.ts uses it to keep pick
// tolerances a constant number of SCREEN pixels, the same way it already
// depends on this module's font state to measure label boxes.
export function currentZoom(): number {
  return renderZoom;
}

// The font stack the canvas uses when the .fzm asks for "Arial" - which is what
// every file written by the Java tool says, since it was Swing's default rather
// than anyone's choice. A file naming any other font gets that font: it was
// picked deliberately. This is a view-layer substitution; the .fzm still says
// Arial and Preferences still shows Arial.
const UI_FONT_STACK = '"Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif';

export function fontFamilyFor(name: string): string {
  const n = (name || '').trim();
  return !n || n.toLowerCase() === 'arial' ? UI_FONT_STACK : `"${n}", ${UI_FONT_STACK}`;
}

export let TEXT_FONT = `11px ${UI_FONT_STACK}`;
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
// webview's current surface mode and zoom level. Kept as module state so the
// draw helpers don't each need extra params.
let theme: Theme = makeTheme('paper');
let lineW = 1;
let hover: Selection | null = null;
// Zoom at the last render(). Handles are drawn in model units under a zoom-scaled
// transform, so a fixed size would grow with zoom while main.ts's grab tolerance
// (TOL() = 6/zoom) stays a constant number of screen pixels - at 400% the handle
// looked 28px wide but only its middle 6px could be grabbed, and at 25% it drew
// too small to aim at. Dividing by this keeps the drawn handle the same size on
// screen at every zoom, so what you see is what you can grab.
let renderZoom = 1;
// A state's name is the object's title; its outputs are supporting detail. The
// weight difference is what gives a state a reading order at a glance.
let NAME_FONT = `600 11px ${UI_FONT_STACK}`;
const DEFAULT_BLACK = -16777216;

export interface RenderOptions {
  zoom: number;
  /** The palette to draw with (see theme.ts). */
  theme: Theme;
  /**
   * Device pixel ratio. The canvas buffer is sized in device pixels and the
   * drawing transform scales by zoom x dpr, so strokes land on real pixels
   * instead of being resampled on a HiDPI display.
   */
  dpr?: number;
  fontPx?: number;
  fontName?: string;
  lineWidth?: number;
  showTable?: boolean;
  // The attribute label currently being dragged: `selection` is null during a
  // label drag, so this is how the red box stays visible while you move it.
  dragLabel?: AttrLabelTarget;
  /** The object under the cursor, highlighted so the canvas answers the mouse. */
  hover?: Selection | null;
  group?: Selection[];
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** An in-progress drag-to-connect: rubber-band from a source state to a point. */
  connect?: { fromState: number; to: Point; target: number | null } | null;
}

const sameSel = (a: Selection | null, b: Selection | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.index === b.index;

// The four connect anchors on a state's border (top, right, bottom, left) —
// where a drag-to-connect gesture starts. Kept here, next to where they're
// drawn; hitTest.ts imports this for the grab test.
export function stateConnectAnchors(s: FzmState): Point[] {
  const rx = (s.x1 - s.x0) / 2;
  const ry = (s.y1 - s.y0) / 2;
  const cx = s.x0 + rx;
  const cy = s.y0 + ry;
  return [
    { x: cx, y: cy - ry },
    { x: cx + rx, y: cy },
    { x: cx, y: cy + ry },
    { x: cx - rx, y: cy },
  ];
}

// The color to actually draw an object with: its stored color, except the
// default black is swapped for a theme token so black shapes stay visible on a
// dark background. `fallback` lets a caller say what "default" means in its
// context (ink for a title, muted for supporting text); a color the user chose
// deliberately is always honored as-is.
function resolveColor(rgb: number, fallback: string = theme.ink): string {
  return rgb === DEFAULT_BLACK ? fallback : colorToCss(rgb);
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
// F17: StateObj.getCenter uses integer division (int x0/x1/y0/y1).
export function stateAnchor(s: FzmState): Point {
  return { x: s.x0 + Math.trunc((s.x1 - s.x0) / 2), y: s.y0 + Math.trunc((s.y1 - s.y0) / 4) };
}

// Draws an object's visible attribute labels, each centered on
// anchor + (x2Obj, y2Obj) and stacked by its visible index (Java's `step`).
// Ports GeneralObj.paintComponent's attribute loop + ObjAttribute.paintComponent.
// One object's labels, in one pass. Plates and text are separate passes across
// the whole page (see LabelJob): a plate is opaque, so if it were drawn right
// before its own text it would erase any *other* label it happens to overlap -
// turning a visible collision into silently hidden data.
function drawAttrLabels(
  ctx: CanvasRenderingContext2D,
  attributes: ObjAttribute[],
  info: OutputInfo,
  anchor: Point,
  filterPage: number | undefined,
  pass: 'plate' | 'text'
): void {
  ctx.textAlign = 'center';
  visibleAttrLabels(attributes, info).forEach((lab, step) => {
    // On a cross-page transition each label lives on its own page (Java's
    // ObjAttribute.paintComponent `myPage == currPage`), but `step` still counts
    // every visible attribute so the stacking positions stay stable.
    if (filterPage !== undefined && lab.attr.page !== filterPage) return;
    if (pass === 'plate') {
      const b = labelBox(ctx, lab, anchor, step);
      ctx.fillStyle = theme.plate;
      ctx.fillRect(b.l + 2, b.t, b.r - b.l - 4, b.b - b.t);
      return;
    }
    const cx = anchor.x + lab.attr.x2Obj;
    const baseY = anchor.y + step * TEXT_LINE_H + lab.attr.y2Obj;
    ctx.font = fontForLabel(lab);
    ctx.fillStyle = resolveColor(lab.attr.color, isTitle(lab) ? theme.ink : theme.muted);
    // Literal "\n" in an attribute value splits into multiple stacked lines.
    lab.text.split('\\n').forEach((line, li) => ctx.fillText(line, cx, baseY + li * TEXT_LINE_H));
  });
}

// A deferred label draw. The render loop walks the page once to draw shapes and
// collect these, then plays them back twice: every plate, then every text. That
// ordering is what keeps a transition's plate from punching a hole in a state
// or in another transition's label, while still letting it hide the curve
// underneath - which is the only thing it's there for.
interface LabelJob {
  attributes: ObjAttribute[];
  anchor: Point;
  filterPage?: number;
  plate: boolean;
}

// A label that names its object (a state's name, a transition's equation) is the
// thing you read first; everything else on the object is supporting detail.
function isTitle(lab: AttrLabel): boolean {
  return lab.attr.name === 'name' || lab.attr.name === 'equation';
}

// The font a label draws with. Every place that measures a label (the render,
// the red box, the hit test) goes through this, so bold titles can't put the
// three out of sync.
export function fontForLabel(lab: AttrLabel): string {
  return isTitle(lab) ? NAME_FONT : TEXT_FONT;
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
  ctx.font = fontForLabel(lab);
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
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  visibleAttrLabels(attributes, info).forEach((lab, step) => {
    if (filterPage !== undefined && lab.attr.page !== filterPage) return;
    const b = labelBox(ctx, lab, anchor, step);
    ctx.strokeRect(b.l, b.t, b.r - b.l, b.b - b.t);
  });
}

// Index (into `attributes`) of the topmost visible label under (x, y), or -1.
function labelHitIn(ctx: CanvasRenderingContext2D, attributes: ObjAttribute[], info: OutputInfo, anchor: Point, x: number, y: number, filterPage?: number): number {
  // labelBox sets the per-label font itself, so hit boxes match what was drawn.
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

function drawState(ctx: CanvasRenderingContext2D, s: FzmState, hovered: boolean): void {
  const rx = (s.x1 - s.x0) / 2;
  const ry = (s.y1 - s.y0) / 2;
  const cx = s.x0 + rx;
  const cy = s.y0 + ry;

  // Filled, not hollow: an unfilled outline is what made these read as Swing
  // line art. The fill is faint enough to survive printing (see theme.stateFill)
  // and it gives labels something to sit on instead of the bare grid.
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = hovered ? theme.accentSoft : theme.stateFill;
  ctx.fill();

  ctx.strokeStyle = resolveColor(s.color);
  ctx.lineWidth = lineW;
  ctx.stroke();

  // The reset state's second ring. Kept (it's FSM convention, not a Java
  // artifact) and kept in the object's own color rather than the accent: this
  // one is in the export, and a blue ring on a printed diagram would be a
  // surprise, not a design.
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
  ctx.fillStyle = theme.ink;

  // Column widths are still measured off the widest cell (Java's layout), but
  // section headers now carry weight and the cells drop to muted, so the table
  // has a hierarchy instead of being a wall of identical 11px text.
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
    ctx.font = r.header ? NAME_FONT : TEXT_FONT;
    ctx.fillStyle = r.header ? theme.ink : theme.muted;
    ctx.fillText(r.c1, x1, ry);
    if (!r.header) {
      ctx.fillText(r.c2, x2, ry);
      ctx.fillText(r.c3, x3, ry);
      ctx.fillText(r.c4, x4, ry);
    }
  });
  ctx.font = TEXT_FONT;
}

// The arrowhead: Java's flat triangle, given a notched tail so it reads as a
// point rather than a wedge, and scaled with the file's LineWidth so a heavy
// diagram gets heavy arrows instead of the same 13px head on every line.
function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = ARROW_LENGTH * (1 + (lineW - 1) * 0.35);
  const x1 = to.x - len * Math.cos(angle - ARROW_ANGLE);
  const y1 = to.y - len * Math.sin(angle - ARROW_ANGLE);
  const x2 = to.x - len * Math.cos(angle + ARROW_ANGLE);
  const y2 = to.y - len * Math.sin(angle + ARROW_ANGLE);
  // The tail notch: pulled back toward the tip so the barbs sweep instead of
  // ending in a flat edge.
  const bx = to.x - len * 0.72 * Math.cos(angle);
  const by = to.y - len * 0.72 * Math.sin(angle);

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(x1, y1);
  ctx.lineTo(bx, by);
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
  ctx.fillStyle = theme.ink;
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
  ctx.fillStyle = theme.ink;
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

function drawCurve(ctx: CanvasRenderingContext2D, t: FzmTransition | FzmLoopback, hovered: boolean): void {
  if (hovered) {
    // Thicken rather than recolor: a transition's color can be meaningful, and
    // the halo says "under the cursor" without lying about which edge this is.
    ctx.strokeStyle = theme.accentSoft;
    ctx.lineWidth = lineW + 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(t.startPt.x, t.startPt.y);
    ctx.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
    ctx.stroke();
  }
  ctx.strokeStyle = resolveColor(t.color);
  ctx.fillStyle = resolveColor(t.color);
  ctx.lineWidth = lineW;
  // Round caps/joins: the butt caps left visible notches where a curve met its
  // arrowhead, which is a lot of what made the edges look like line art.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(t.startPt.x, t.startPt.y);
  ctx.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
  ctx.stroke();
  ctx.lineCap = 'butt';

  drawArrowhead(ctx, t.endCtrlPt, t.endPt);
}

// A grab point. Surface-filled with an accent border (the draw.io/Figma idiom)
// rather than Swing's solid red square: it reads as "handle" instead of "error",
// and the light interior keeps it visible over a dark shape.
function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const size = handleSize();
  const h = size / 2;
  ctx.beginPath();
  ctx.roundRect(x - h, y - h, size, size, 2 / renderZoom);
  ctx.fillStyle = theme.handleFill;
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5 / renderZoom;
  ctx.stroke();
}

// The soft outer glow that says "this one". Traces the object's own shape, so
// the eye lands on the object rather than on a box drawn around it.
function haloEllipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.strokeStyle = theme.accentGlow;
  ctx.lineWidth = lineW + 5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

// Guide line from an endpoint to its control point: dashed and accent, so it
// reads as scaffolding rather than as part of the diagram.
function drawGuide(ctx: CanvasRenderingContext2D, a: Point, b: Point): void {
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawStateSelection(ctx: CanvasRenderingContext2D, s: FzmState): void {
  const rx = (s.x1 - s.x0) / 2;
  const ry = (s.y1 - s.y0) / 2;
  haloEllipse(ctx, s.x0 + rx, s.y0 + ry, rx + (s.reset ? RESET_RING_OFFSET : 0), ry + (s.reset ? RESET_RING_OFFSET : 0));
  // The box isn't decoration - it's where the resize handles live.
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  drawHandle(ctx, s.x0, s.y0);
  drawHandle(ctx, s.x1, s.y0);
  drawHandle(ctx, s.x0, s.y1);
  drawHandle(ctx, s.x1, s.y1);
}

function drawCurveSelection(ctx: CanvasRenderingContext2D, t: FzmTransition | FzmLoopback): void {
  // Halo the curve itself: translucent, so the transition still shows through.
  ctx.strokeStyle = theme.accentGlow;
  ctx.lineWidth = lineW + 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(t.startPt.x, t.startPt.y);
  ctx.bezierCurveTo(t.startCtrlPt.x, t.startCtrlPt.y, t.endCtrlPt.x, t.endCtrlPt.y, t.endPt.x, t.endPt.y);
  ctx.stroke();
  ctx.lineCap = 'butt';

  drawGuide(ctx, t.startPt, t.startCtrlPt);
  drawGuide(ctx, t.endPt, t.endCtrlPt);

  drawHandle(ctx, t.startPt.x, t.startPt.y);
  drawHandle(ctx, t.endPt.x, t.endPt.y);
  drawHandle(ctx, t.startCtrlPt.x, t.startCtrlPt.y);
  drawHandle(ctx, t.endCtrlPt.x, t.endCtrlPt.y);
}

function drawStubSelection(ctx: CanvasRenderingContext2D, t: FzmTransition): void {
  const { pt, tip } = sameStub(t);
  ctx.strokeStyle = theme.accentGlow;
  ctx.lineWidth = lineW + 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.lineCap = 'butt';
  drawHandle(ctx, pt.x, pt.y);
  drawHandle(ctx, tip.x, tip.y);
}

function drawTextSelection(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const b = textBounds(ctx, text, x, y);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x - 3, b.y - 2, b.width + 6, b.height + 4);
}

export function render(
  ctx: CanvasRenderingContext2D,
  doc: FzmDocument,
  page: number,
  selection: Selection | null,
  opts: RenderOptions = { zoom: 1, theme: makeTheme('paper') }
): void {
  theme = opts.theme;
  TEXT_FONT = `${opts.fontPx ?? 11}px ${fontFamilyFor(opts.fontName ?? '')}`;
  NAME_FONT = `600 ${opts.fontPx ?? 11}px ${fontFamilyFor(opts.fontName ?? '')}`;
  lineW = opts.lineWidth ?? 1;
  hover = opts.hover ?? null;
  const canvas = ctx.canvas;
  // Model units -> device pixels. The buffer is zoom x dpr times the model size,
  // so drawing in model coordinates under this transform puts every stroke on a
  // real device pixel instead of a CSS pixel that then gets resampled.
  renderZoom = opts.zoom || 1;
  const scale = opts.zoom * (opts.dpr ?? 1);

  // Paint the surface over the whole (device-pixel) canvas, then draw everything
  // in model coordinates scaled by that factor.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // Alignment grid (when enabled in the .fzm): a dot at each intersection rather
  // than full-bleed rules, which read as graph paper and competed with the
  // diagram. Dots give you the same snapping reference and then get out of the way.
  if (doc.preferences.grid && doc.preferences.gridSize > 0) {
    const g = doc.preferences.gridSize;
    const w = canvas.width / scale;
    const h = canvas.height / scale;
    ctx.fillStyle = theme.grid;
    // A constant size *on screen*, so the dots neither swell into blobs as you
    // zoom in nor vanish as you zoom out. Sizing them in device pixels instead
    // (the first cut) made them invisible on any HiDPI display: one device pixel
    // is a fraction of a CSS pixel there, and a fraction of a pixel at low alpha
    // renders as almost nothing.
    const d = GRID_DOT_PX / opts.zoom;
    // One path for every dot + one fill(), instead of a fillRect() per dot -
    // a large page at a small grid size is thousands of dots, and each
    // fillRect is its own draw call. This runs every redraw (including per
    // mousemove during a drag), so batching it matters.
    ctx.beginPath();
    for (let gx = 0; gx <= w; gx += g) {
      for (let gy = 0; gy <= h; gy += g) ctx.rect(gx - d / 2, gy - d / 2, d, d);
    }
    ctx.fill();
  }

  const outputInfo = buildOutputInfo(doc.outputs);
  // Labels are collected here and drawn after every shape on the page (plates
  // first, then text). States are pushed before transitions, so a transition's
  // label still wins over a state's where they overlap - Java's z-order.
  const labelJobs: LabelJob[] = [];
  doc.states.forEach((s, i) => {
    if (s.page === page) {
      drawState(ctx, s, sameSel(hover, { kind: 'state', index: i }));
      // Name + visible outputs/attributes, each independently positioned & movable.
      labelJobs.push({ attributes: s.attributes, anchor: stateAnchor(s), plate: false });
    }
  });
  // A transition is drawn in full only when both endpoint states are on this
  // page. If exactly one endpoint is on the page, draw a page-connector "stub"
  // instead (like Fizzim), so the cross-page link is visible.
  const statePage = new Map(doc.states.map((s) => [s.name, s.page]));
  doc.transitions.forEach((t, i) => {
    const hovered = sameSel(hover, { kind: 'transition', index: i });
    if (t.kind === 'loopback') {
      if (statePage.get(t.state) === page) {
        drawCurve(ctx, t, hovered);
        labelJobs.push({ attributes: t.attributes, anchor: transitionLabelAnchor(t, doc, page), plate: true });
      }
      return;
    }
    const sp = statePage.get(t.startState);
    const ep = statePage.get(t.endState);
    if (t.stub) {
      // Stub wins over cross-page (StateTransitionObj.java's paintComponent
      // gates every cross-page branch on !stub, and only draws the stub on
      // the start state's page - "if(currPage == sPage && stub)"). Even if
      // the endpoints end up on different pages (e.g. after Move to Page
      // with Stub? already ticked), nothing draws on the end state's page.
      if (sp === page) {
        drawSameStub(ctx, t);
        labelJobs.push({ attributes: t.attributes, anchor: transitionLabelAnchor(t, doc, page), plate: true });
      }
    } else if (sp === page && ep === page) {
      drawCurve(ctx, t, hovered);
      // Same-page: all labels draw here, regardless of their stored page.
      labelJobs.push({ attributes: t.attributes, anchor: transitionLabelAnchor(t, doc, page), plate: true });
    } else if (sp === page) {
      drawCrossPageStub(ctx, doc, t, 'source');
      // Cross-page: only the labels assigned to this page (Java's per-attribute
      // page); the rest show on the other endpoint's page.
      labelJobs.push({ attributes: t.attributes, anchor: transitionLabelAnchor(t, doc, page), filterPage: page, plate: true });
    } else if (ep === page) {
      drawCrossPageStub(ctx, doc, t, 'dest');
      labelJobs.push({ attributes: t.attributes, anchor: transitionLabelAnchor(t, doc, page), filterPage: page, plate: true });
    }
  });

  for (const j of labelJobs) {
    if (j.plate) drawAttrLabels(ctx, j.attributes, outputInfo, j.anchor, j.filterPage, 'plate');
  }
  for (const j of labelJobs) drawAttrLabels(ctx, j.attributes, outputInfo, j.anchor, j.filterPage, 'text');
  for (const txt of doc.texts) {
    if (txt.page !== page) continue;
    if (txt.isGlobalTable) {
      if (opts.showTable !== false) drawGlobalTable(ctx, doc, txt.x, txt.y);
      continue;
    }
    ctx.fillStyle = theme.ink;
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
        const fp = t.kind === 'transition' && !t.stub && !transitionOnPage(doc, t, page) ? page : undefined;
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
      // Stub wins over cross-page (matches the draw loop above and Java's
      // paintComponent, which gates every cross-page branch on !stub).
      const isStub = t.kind === 'transition' && t.stub;
      const crossPage = t.kind === 'transition' && !isStub && !transitionOnPage(doc, t, page);
      // Equation / priority / any visible label of the selected transition.
      const fp = crossPage ? page : undefined;
      drawLabelBoxes(ctx, t.attributes, outputInfo, transitionLabelAnchor(t, doc, page), fp);
      if (crossPage) {
        // Cross-page: this page's four handles + guide lines (Java's paint).
        const side = statePage.get(t.startState) === page ? 'source' : 'dest';
        const [anchor, anchorCtrl, edgeCtrl, edge] =
          side === 'source'
            ? [t.startPt, t.startCtrlPt, t.pageSC, t.pageS]
            : [t.endPt, t.endCtrlPt, t.pageEC, t.pageE];
        drawGuide(ctx, anchor, anchorCtrl);
        drawGuide(ctx, edge, edgeCtrl);
        for (const p of [anchor, anchorCtrl, edgeCtrl, edge]) drawHandle(ctx, p.x, p.y);
      } else if (isStub) {
        drawStubSelection(ctx, t);
      } else {
        drawCurveSelection(ctx, t);
      }
    } else if (selection.kind === 'text') {
      const txt = doc.texts[selection.index];
      drawTextSelection(ctx, txt.text ?? '', txt.x, txt.y);
    }
  }

  // Multi-selection: a plain accent outline around each grouped object.
  if (opts.group && opts.group.length) {
    ctx.strokeStyle = theme.accent;
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
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0);
    const h = Math.abs(m.y1 - m.y0);
    ctx.fillStyle = theme.accentSoft;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }

  // Drag-to-connect: the rubber-band from the source state to the cursor, plus a
  // ring around the state it would land on. When nothing is being connected, a
  // hovered state shows its four connect anchors (the grab points).
  if (opts.connect) {
    const from = doc.states[opts.connect.fromState];
    const to = opts.connect.to;
    if (from) {
      // Start the line at the source-border anchor nearest the cursor.
      let start = from ? stateConnectAnchors(from)[0] : to;
      let best = Infinity;
      for (const a of stateConnectAnchors(from)) {
        const d = Math.hypot(a.x - to.x, a.y - to.y);
        if (d < best) { best = d; start = a; }
      }
      if (opts.connect.target !== null) {
        const t = doc.states[opts.connect.target];
        if (t) {
          const rx = (t.x1 - t.x0) / 2, ry = (t.y1 - t.y0) / 2;
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(t.x0 + rx, t.y0 + ry, rx + 3, ry + 3, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = theme.accent;
      ctx.fillStyle = theme.accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowhead(ctx, start, to);
    }
  } else if (hover?.kind === 'state') {
    const s = doc.states[hover.index];
    if (s && s.page === page) {
      ctx.fillStyle = theme.surface;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5;
      for (const a of stateConnectAnchors(s)) {
        ctx.beginPath();
        ctx.ellipse(a.x, a.y, 4, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
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
  const grow = (p: Point) => {
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };

  for (const s of doc.states) {
    if (s.page !== page) continue;
    grow({ x: s.x1, y: s.y1 });
  }
  // A transition is relevant to `page` by its endpoint STATES' pages - same
  // test render() uses to decide same-page/cross-page/off-page - not its own
  // `page` field, which (like Java's myPage) only tracks the start state's
  // side. Each on-page piece grows the bounds by whatever's actually drawn
  // there: the full curve, a same-page stub's tip, or a cross-page connector's
  // on-page handles - so a dragged stub tip or connector handle is never
  // pushed somewhere the canvas can't scroll to.
  const statePage = new Map(doc.states.map((s) => [s.name, s.page]));
  for (const t of doc.transitions) {
    if (t.kind === 'loopback') {
      if (statePage.get(t.state) !== page) continue;
      [t.startPt, t.endPt, t.startCtrlPt, t.endCtrlPt].forEach(grow);
      continue;
    }
    const sp = statePage.get(t.startState);
    const ep = statePage.get(t.endState);
    if (sp === page && ep === page) {
      (t.stub ? [t.startPt, t.pageS] : [t.startPt, t.endPt, t.startCtrlPt, t.endCtrlPt]).forEach(grow);
    } else if (sp === page) {
      [t.startPt, t.startCtrlPt, t.pageSC, t.pageS].forEach(grow);
    } else if (ep === page) {
      [t.endPt, t.endCtrlPt, t.pageEC, t.pageE].forEach(grow);
    }
  }
  for (const txt of doc.texts) {
    if (txt.page !== page) continue;
    grow({ x: txt.x + 100, y: txt.y });
  }
  return { width: maxX + 50, height: maxY + 50 };
}
