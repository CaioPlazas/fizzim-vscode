import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { attrIsVisible, attrLabelText, buildGlobalTableRows, buildOutputInfo, computeBounds, curveAnchor, hitAttrLabel, render, stateAnchor, transitionOnPage, visibleAttrLabels } from './render';
import { createState, createTransition, moveStateToPage, setTransitionStub } from './edit';
import { addInput, addOutput } from './globals';
import { makeTheme } from './theme';
import { DEFAULT_PREFERENCES, FzmDocument, ObjAttribute } from '../fzm/model';

function attr(over: Partial<ObjAttribute>): ObjAttribute {
  return {
    name: 'a', nameStatus: 'GLOBAL_FIXED', value: 'v', valueStatus: 'LOCAL',
    visibility: 1, visibilityStatus: 'LOCAL', type: '', typeStatus: 'LOCAL',
    comment: '', commentStatus: 'LOCAL', color: -16777216, colorStatus: 'LOCAL',
    useratts: '', userattsStatus: 'LOCAL', resetval: '', resetvalStatus: 'LOCAL',
    x2Obj: 0, y2Obj: 0, page: 1, ...over,
  };
}

// A real Fizzim document always has at least the reserved state/trans
// "name"/"equation" global attributes (defaultDocument() seeds the same) -
// createState/createTransition seed new objects from these lists, so a doc
// without them isn't a realistic starting point.
function emptyDoc(): FzmDocument {
  return {
    version: '14.02.28', versionInt: 140228,
    machine: [], inputs: [], outputs: [],
    stateAttrs: [attr({ name: 'name', nameStatus: 'ABS', value: 'def_name', visibility: 1, type: 'def_type', valueStatus: 'GLOBAL_VAR', typeStatus: 'GLOBAL_VAR' })],
    transAttrs: [
      attr({ name: 'name', nameStatus: 'ABS', value: 'def_name', visibility: 0, type: 'def_type', valueStatus: 'GLOBAL_VAR', typeStatus: 'GLOBAL_VAR' }),
      attr({ name: 'equation', nameStatus: 'ABS', value: '1', visibility: 1, type: 'def_type', valueStatus: 'GLOBAL_VAR', typeStatus: 'GLOBAL_VAR' }),
    ],
    tabs: ['Page 1'], preferences: { ...DEFAULT_PREFERENCES }, states: [], transitions: [], texts: [],
  };
}

// A canvas context stub that records the calls the assertions below care about.
// Enough of the 2D API for render() to run headless; everything else is a no-op.
function fakeCtx(bufferW: number, bufferH: number) {
  const transforms: number[][] = [];
  const fills: { style: unknown; rect: number[]; seq: number }[] = [];
  const lines: number[][] = [];
  const texts: { text: string; font: string; style: unknown; at: number[]; seq: number }[] = [];
  let seq = 0;
  // The grid batches its dots into one beginPath()/rect()-per-dot/fill() (see
  // render.ts) instead of a fillRect() per dot; track pending rect() calls and
  // flush them into `fills` on fill(), so the grid tests below can keep
  // asserting against `fills` exactly as if each dot were still its own
  // fillRect call.
  let pendingRects: number[][] = [];
  const ctx = {
    canvas: { width: bufferW, height: bufferH },
    font: '',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    globalAlpha: 1,
    textAlign: '',
    setTransform: (...a: number[]) => void transforms.push(a),
    fillRect: (...r: number[]) => void fills.push({ style: ctx.fillStyle, rect: r, seq: seq++ }),
    moveTo: (...p: number[]) => void lines.push(p),
    lineTo: (...p: number[]) => void lines.push(p),
    fillText: (text: string, ...at: number[]) => void texts.push({ text, font: ctx.font, style: ctx.fillStyle, at, seq: seq++ }),
    // Font-aware on purpose: bold is wider, which is what lets the tests below
    // catch a label being measured with a different font than it's drawn with.
    measureText: (t: string) => ({ width: t.length * (ctx.font.startsWith('600') ? 7 : 6) }),
    save: () => {}, restore: () => {}, beginPath: () => { pendingRects = []; }, closePath: () => {},
    rect: (...r: number[]) => void pendingRects.push(r),
    stroke: () => {},
    fill: () => {
      for (const r of pendingRects) fills.push({ style: ctx.fillStyle, rect: r, seq: seq++ });
      pendingRects = [];
    },
    strokeRect: () => {}, roundRect: () => {},
    ellipse: () => {}, bezierCurveTo: () => {}, setLineDash: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, transforms, fills, lines, texts };
}

test('render scales its transform by zoom x dpr, so strokes land on device pixels', () => {
  // The v1 bug this guards: the buffer was sized in CSS pixels and the transform
  // scaled by zoom alone, so on a HiDPI display every stroke was resampled.
  const doc = emptyDoc();
  const { ctx, transforms } = fakeCtx(800, 600);
  render(ctx, doc, 1, null, { zoom: 1.5, dpr: 2, theme: makeTheme('paper') });
  // First transform is the identity used to paint the surface; the second is the
  // model -> device transform everything is drawn under.
  assert.deepEqual(transforms[0], [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(transforms[1], [3, 0, 0, 3, 0, 0], 'zoom 1.5 x dpr 2 = scale 3');
});

test('render defaults to dpr 1, so a non-HiDPI screen and the exporter are unscaled', () => {
  const { ctx, transforms } = fakeCtx(400, 300);
  render(ctx, emptyDoc(), 1, null, { zoom: 1, theme: makeTheme('paper') });
  assert.deepEqual(transforms[1], [1, 0, 0, 1, 0, 0]);
});

test('render paints the theme surface over the whole device-pixel buffer', () => {
  const { ctx, fills } = fakeCtx(800, 600);
  render(ctx, emptyDoc(), 1, null, { zoom: 2, dpr: 2, theme: makeTheme('theme', { editorBackground: '#1f1f1f' }) });
  assert.equal(fills[0].style, '#1f1f1f');
  assert.deepEqual(fills[0].rect, [0, 0, 800, 600]);
});

test('the grid spans the buffer in model units, not device pixels', () => {
  // Regression guard for the dpr fix: dividing the buffer by zoom alone (the v1
  // math) would over-count the extent by dpr and draw 2x the needed dots.
  const doc = emptyDoc();
  doc.preferences.grid = true;
  doc.preferences.gridSize = 100;
  const { ctx, fills } = fakeCtx(800, 600); // 800x600 device px at zoom 1 x dpr 2 = 400x300 model
  render(ctx, doc, 1, null, { zoom: 1, dpr: 2, theme: makeTheme('paper') });
  const dots = fills.slice(1); // fills[0] is the surface
  // 0,100,...,400 across x 0,100,...,300 down = 5 x 4.
  assert.equal(dots.length, 20);
  // Dots are drawn centred on the intersection, so measure the centre.
  const cx = dots.map((d) => d.rect[0] + d.rect[2] / 2);
  const cy = dots.map((d) => d.rect[1] + d.rect[3] / 2);
  assert.equal(Math.max(...cx), 400, 'dots stop at the model-space right edge');
  assert.equal(Math.max(...cy), 300, 'dots stop at the model-space bottom edge');
});

test('a grid dot keeps a constant on-screen size at any zoom or dpr', () => {
  // Sized in CSS pixels, not device pixels: the first cut divided by zoom x dpr,
  // which made every dot a single device pixel — a sub-CSS-pixel speck at 22%
  // alpha, i.e. an invisible grid on any HiDPI display. It also must not be
  // sized in model units, or it would swell into a blob as you zoom in.
  const doc = emptyDoc();
  doc.preferences.grid = true;
  doc.preferences.gridSize = 100;
  const cssSize = (zoom: number, dpr: number) => {
    const { ctx, fills } = fakeCtx(800, 600);
    render(ctx, doc, 1, null, { zoom, dpr, theme: makeTheme('paper') });
    return fills[1].rect[2] * zoom; // model units -> CSS px
  };
  assert.equal(cssSize(1, 1), 1.5);
  assert.equal(cssSize(4, 2), 1.5, 'zoomed in 4x on a HiDPI screen: same size on screen');
  assert.equal(cssSize(0.5, 1), 1.5, 'zoomed out: still there');
});

test('a state name draws bold, its outputs draw regular and muted', () => {
  const doc = emptyDoc();
  const s = createState(doc, 200, 200, 1);
  addOutput(doc, 'reg'); // propagates an output attribute onto the state
  // Visibility 2 (Java's NONDEFAULT) only draws once the value is a local
  // override, i.e. the user actually set this output on this state.
  const out = s.attributes.find((a) => a.name === 'out')!;
  out.valueStatus = 'LOCAL';
  out.value = '1';
  const { ctx, texts } = fakeCtx(800, 600);
  const theme = makeTheme('paper');
  render(ctx, doc, 1, null, { zoom: 1, theme });
  const name = texts.find((t) => t.text === 'state0');
  const output = texts.find((t) => t.text.startsWith('out'));
  assert.ok(name && output, 'both labels drew');
  assert.ok(name!.font.startsWith('600 '), `name should be bold, got ${name!.font}`);
  assert.equal(name!.style, theme.ink);
  assert.ok(!output!.font.startsWith('600 '), 'output label should not be bold');
  assert.equal(output!.style, theme.muted, 'output label is supporting detail');
});

test('every label plate is drawn before every label text', () => {
  // The bug this caught in review: a transition's plate is opaque, and drawing
  // it immediately before its own text meant it erased any label it overlapped
  // — turning a visible collision into silently missing data. Plates belong in
  // a pass of their own, ahead of all text.
  const doc = emptyDoc();
  const a = createState(doc, 150, 150, 1);
  const b = createState(doc, 400, 150, 1);
  // Two transitions whose labels land on top of each other.
  createTransition(doc, a, b, 1);
  createTransition(doc, b, a, 1);
  const theme = makeTheme('paper');
  const { ctx, fills, texts } = fakeCtx(800, 600);
  render(ctx, doc, 1, null, { zoom: 1, theme });

  const plates = fills.filter((f) => f.style === theme.plate);
  assert.ok(plates.length >= 2, `expected a plate per transition label, got ${plates.length}`);
  assert.ok(texts.length > 0, 'labels drew');
  assert.ok(
    Math.max(...plates.map((p) => p.seq)) < Math.min(...texts.map((t) => t.seq)),
    'the last plate must be drawn before the first label text'
  );
});

test('a deliberately colored label keeps its color; only default-black follows the theme', () => {
  const doc = emptyDoc();
  const s = createState(doc, 200, 200, 1);
  s.attributes[0].color = 0x00ff00;
  const { ctx, texts } = fakeCtx(800, 600);
  render(ctx, doc, 1, null, { zoom: 1, theme: makeTheme('paper') });
  assert.equal(texts.find((t) => t.text === 'state0')!.style, 'rgb(0, 255, 0)');
});

test('a bold name is hit-tested with the bold metrics it was drawn with', () => {
  // The Phase B trap: titles render in NAME_FONT but the box that catches the
  // click measured in TEXT_FONT, so grabbing a label near its edge would miss.
  const doc = emptyDoc();
  const s = createState(doc, 200, 200, 1);
  const { ctx } = fakeCtx(800, 600);
  render(ctx, doc, 1, null, { zoom: 1, theme: makeTheme('paper') });
  const anchor = stateAnchor(s);
  // "state0" = 6 chars: bold measures 42 wide, regular 36. Centered on the
  // anchor, +4 padding => the bold box reaches 25 from center, regular only 22.
  const inBoldOnly = anchor.x + 24;
  assert.ok(hitAttrLabel(ctx, doc, 1, inBoldOnly, anchor.y), 'point inside the bold box must hit');
  assert.equal(hitAttrLabel(ctx, doc, 1, anchor.x + 30, anchor.y), null, 'well outside must not hit');
});

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

test('computeBounds includes a same-page stub tip (regression: a dragged stub tip used to be excluded)', () => {
  const doc = emptyDoc();
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const t = createTransition(doc, a, b, 1);
  setTransitionStub(doc, t, true);
  if (t.kind === 'transition') t.pageS = { x: 9000, y: 8000 }; // drag the tip far out
  const bounds = computeBounds(doc, 1);
  assert.ok(bounds.width >= 9000, `width ${bounds.width} should include the dragged stub tip`);
  assert.ok(bounds.height >= 8000, `height ${bounds.height} should include the dragged stub tip`);
});

test("computeBounds includes a cross-page connector's on-page handles (regression: excluded, so a dragged handle could land off-canvas)", () => {
  const doc = emptyDoc();
  doc.tabs.push('Page 2');
  const a = createState(doc, 100, 100, 1);
  const b = createState(doc, 400, 100, 1);
  const t = createTransition(doc, a, b, 1);
  moveStateToPage(doc, doc.states.indexOf(b), 2); // now cross-page
  if (t.kind === 'transition') t.pageS = { x: 9000, y: 8000 }; // drag the source handle far out
  const boundsPage1 = computeBounds(doc, 1);
  assert.ok(boundsPage1.width >= 9000, `page 1 width ${boundsPage1.width} should include the dragged source handle`);
  assert.ok(boundsPage1.height >= 8000, `page 1 height ${boundsPage1.height} should include the dragged source handle`);
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
