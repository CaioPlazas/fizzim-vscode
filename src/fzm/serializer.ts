import { FzmDocument, FzmLoopback, FzmPreferences, FzmState, FzmText, FzmTransition, ObjAttribute } from './model';

// Ports the Java save() methods (FizzimGui.saveFile, DrawArea.save,
// ObjAttribute.save, StateObj/StateTransitionObj/LoopbackTransitionObj/TextObj
// .save). The output is designed to round-trip through our own positional
// parser and to be accepted by fizzim.pl. Two Java writer quirks are
// reproduced deliberately (see notes below); they're harmless because reading
// is positional, and reproducing them keeps output faithful.

// Fizzim stamps the current app version on save (FizzimGui.currVer). We always
// emit every version-gated attribute field, so the newest version is correct.
const CURRENT_VERSION = '14.02.28';

function ind(n: number): string {
  return '   '.repeat(n);
}

// Java stores transition coordinates in java.awt.Point (int), but writes them
// via Point.getX()/getY() which return double -> "643.0". Our values are always
// whole, so emit "<n>.0"; guard the fractional case just in case.
function dbl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

// Java reads x0/y0/x1/y1, x2Obj/y2Obj, and text x/y as ints
// (FileParser.java:471-474, :656-664, :375-377) - a fractional value throws
// NumberFormatException in real Fizzim on load. main.ts now rounds at every
// drag site, so this is a no-op for anything the extension itself produces;
// it's a guard against the format's real contract, not a behavior change.
function int(n: number): number {
  return Math.round(n);
}

function serializeAttribute(a: ObjAttribute, indent = 1): string {
  const i1 = ind(indent + 1);
  const i2 = ind(indent + 2);
  const i3 = ind(indent + 3);
  const field = (tag: string, value: string | number, status: string) =>
    `${i2}<${tag}>\n${i2}${value}\n${i3}<status>\n${i3}${status}\n${i3}</status>\n${i2}</${tag}>\n`;

  let out = `${i1}<${a.name}>\n${i3}<status>\n${i3}${a.nameStatus}\n${i3}</status>\n`;
  out += field('value', a.value, a.valueStatus);
  out += field('vis', a.visibility, a.visibilityStatus);
  out += field('type', a.type, a.typeStatus);
  out += field('comment', a.comment, a.commentStatus);
  out += field('color', a.color, a.colorStatus);
  // NOTE: Java writes typeStatus (getEditableName(3)) for the useratts and
  // resetval status lines, not their own status - reproduced for fidelity.
  out += field('useratts', a.useratts, a.typeStatus);
  out += field('resetval', a.resetval, a.typeStatus);
  out += `${i2}<x2Obj>\n${i2}${int(a.x2Obj)}\n${i2}</x2Obj>\n`;
  out += `${i2}<y2Obj>\n${i2}${int(a.y2Obj)}\n${i2}</y2Obj>\n`;
  out += `${i2}<page>\n${i2}${a.page}\n${i2}</page>\n`;
  out += `${i1}</${a.name}>\n`;
  return out;
}

function tag1(name: string, value: string | number): string {
  return `${ind(1)}<${name}>\n${ind(1)}${value}\n${ind(1)}</${name}>\n`;
}

function serializeState(s: FzmState): string {
  let out = '## START STATE OBJECT\n<state>\n';
  out += `${ind(1)}<attributes>\n`;
  for (const a of s.attributes) out += serializeAttribute(a, 1);
  out += `${ind(1)}</attributes>\n`;
  out += tag1('x0', int(s.x0));
  out += tag1('y0', int(s.y0));
  out += tag1('x1', int(s.x1));
  out += tag1('y1', int(s.y1));
  out += tag1('reset', String(s.reset));
  out += tag1('page', s.page);
  out += tag1('color', s.color);
  out += '</state>\n## END STATE OBJECT\n';
  return out;
}

function serializeTransition(t: FzmTransition): string {
  let out = '## START STATE TRANSITION OBJECT\n<transition>\n';
  out += `${ind(1)}<attributes>\n`;
  for (const a of t.attributes) out += serializeAttribute(a, 1);
  out += `${ind(1)}</attributes>\n`;
  out += tag1('startState', t.startState);
  out += tag1('endState', t.endState);
  out += tag1('startPtX', dbl(t.startPt.x));
  out += tag1('startPtY', dbl(t.startPt.y));
  out += tag1('endPtX', dbl(t.endPt.x));
  out += tag1('endPtY', dbl(t.endPt.y));
  out += tag1('startCtrlPtX', dbl(t.startCtrlPt.x));
  out += tag1('startCtrlPtY', dbl(t.startCtrlPt.y));
  // NOTE: Java writes the endCtrlPt X value under an <endCtrlPtY> tag (a
  // copy-paste bug). Reproduced so the positional layout matches exactly.
  out += tag1('endCtrlPtY', dbl(t.endCtrlPt.x));
  out += tag1('endCtrlPtY', dbl(t.endCtrlPt.y));
  out += tag1('startStateIndex', t.startStateIndex);
  out += tag1('endStateIndex', t.endStateIndex);
  out += tag1('page', t.page);
  out += tag1('color', t.color);
  out += tag1('pageSX', dbl(t.pageS.x));
  out += tag1('pageSY', dbl(t.pageS.y));
  out += tag1('pageSCX', dbl(t.pageSC.x));
  out += tag1('pageSCY', dbl(t.pageSC.y));
  out += tag1('pageEX', dbl(t.pageE.x));
  out += tag1('pageEY', dbl(t.pageE.y));
  out += tag1('pageECX', dbl(t.pageEC.x));
  out += tag1('pageECY', dbl(t.pageEC.y));
  out += tag1('stub', String(t.stub));
  out += '</transition>\n## END STATE TRANSITION OBJECT\n';
  return out;
}

function serializeLoopback(t: FzmLoopback): string {
  let out = '## START LOOPBACK TRANSITION OBJECT\n<transition>\n';
  out += `${ind(1)}<attributes>\n`;
  for (const a of t.attributes) out += serializeAttribute(a, 1);
  out += `${ind(1)}</attributes>\n`;
  out += tag1('startState', t.state);
  out += tag1('endState', t.state);
  out += tag1('startPtX', dbl(t.startPt.x));
  out += tag1('startPtY', dbl(t.startPt.y));
  out += tag1('endPtX', dbl(t.endPt.x));
  out += tag1('endPtY', dbl(t.endPt.y));
  out += tag1('startCtrlPtX', dbl(t.startCtrlPt.x));
  out += tag1('startCtrlPtY', dbl(t.startCtrlPt.y));
  out += tag1('endCtrlPtY', dbl(t.endCtrlPt.x));
  out += tag1('endCtrlPtY', dbl(t.endCtrlPt.y));
  out += tag1('startStateIndex', t.startStateIndex);
  out += tag1('endStateIndex', t.endStateIndex);
  out += tag1('page', t.page);
  out += tag1('color', t.color);
  // NOTE: Java's loopback writer emits "## START" here too (should be "## END").
  // Harmless comment; reproduced for fidelity.
  out += '</transition>\n## START LOOPBACK TRANSITION OBJECT\n';
  return out;
}

function serializeText(t: FzmText): string {
  let out = '<textObj>\n';
  out += t.isGlobalTable ? 'fzm_globalTable\n' : `${t.text ?? ''}\n`;
  out += tag1('x', int(t.x));
  out += tag1('y', int(t.y));
  out += tag1('page', t.page);
  out += '</textObj>\n';
  return out;
}

function serializePreferences(p: FzmPreferences): string {
  let out = '## START PREFERENCES\n';
  out += `<SCounter>\n${p.sCounter}\n</SCounter>\n`;
  out += `<TCounter>\n${p.tCounter}\n</TCounter>\n`;
  out += `<TableVis>\n${p.tableVis}\n</TableVis>\n`;
  out += `<TableSpace>\n${p.tableSpace}\n</TableSpace>\n`;
  out += `<TableFont>\n${p.tableFontName}\n${p.tableFontSize}\n</TableFont>\n`;
  out += `<TableColor>\n${p.tableColor}\n</TableColor>\n`;
  out += `<Font>\n${p.fontName}\n${p.fontSize}\n</Font>\n`;
  out += `<Grid>\n${p.grid}\n${p.gridSize}\n</Grid>\n`;
  out += `<PageSizeW>\n${p.pageSizeW}\n</PageSizeW>\n`;
  out += `<PageSizeH>\n${p.pageSizeH}\n</PageSizeH>\n`;
  out += `<StateW>\n${p.stateW}\n</StateW>\n`;
  out += `<StateH>\n${p.stateH}\n</StateH>\n`;
  out += `<LineWidth>\n${p.lineWidth}\n</LineWidth>\n`;
  // Our own addition (not part of the original Fizzim format); unknown tags
  // are safely ignored by both the Java reader and fizzim.pl's parser.
  out += `<CustomArgs>\n${p.customArgs}\n</CustomArgs>\n`;
  out += '## END PREFERENCES\n';
  return out;
}

function serializeGlobalList(name: string, list: ObjAttribute[]): string {
  let out = `${ind(1)}<${name}>\n`;
  for (const a of list) out += serializeAttribute(a, 1);
  out += `${ind(1)}</${name}>\n`;
  return out;
}

export function serializeFzm(doc: FzmDocument): string {
  let out = '## File last modified by Fizzim VS Code\n';
  out += `<version>\n${ind(1)}${CURRENT_VERSION}\n</version>\n`;

  out += '<globals>\n';
  out += serializeGlobalList('machine', doc.machine);
  out += serializeGlobalList('inputs', doc.inputs);
  out += serializeGlobalList('outputs', doc.outputs);
  out += serializeGlobalList('state', doc.stateAttrs);
  out += serializeGlobalList('trans', doc.transAttrs);
  out += '</globals>\n';

  out += '<tabs>\n';
  for (const tab of doc.tabs) out += `${ind(1)}${tab}\n`;
  out += '</tabs>\n';

  out += serializePreferences(doc.preferences);

  out += '## START OBJECTS\n';
  for (const t of doc.texts) out += serializeText(t);
  for (const s of doc.states) out += serializeState(s);
  for (const t of doc.transitions) {
    out += t.kind === 'loopback' ? serializeLoopback(t) : serializeTransition(t);
  }
  out += '## END OBJECTS\n';

  return out;
}
