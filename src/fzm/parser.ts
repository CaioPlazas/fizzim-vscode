import { DEFAULT_PREFERENCES, FzmDocument, FzmLoopback, FzmPreferences, FzmState, FzmText, FzmTransition, ObjAttribute } from './model';

// Ports FileParser.java. The .fzm format is not real XML: every field is read
// by absolute line offset, not by tag name (see fizzim-java/FileParser.java).
// This parser mirrors that positional approach on purpose, using a running
// line pointer the same way the Java code does, rather than a name-based
// reader - two known bugs in the Java writer (a duplicated <endCtrlPtY> tag,
// and <useratts>/<resetval> reusing type's status) are only harmless because
// reading is positional, and a name-based parser would trip over them.

function readSimpleValue(next: () => string | null): string {
  let v = next();
  while (v !== null && v.startsWith('##')) {
    v = next();
  }
  return v ?? '';
}

function readAttributeList(lines: string[], start: number, end: number, ver: number): ObjAttribute[] {
  const result: ObjAttribute[] = [];
  let s = start;

  while (s < end - 2) {
    let p = s;
    const tag = lines[p];
    const name = tag.slice(1, -1);

    p += 2;
    const nameStatus = lines[p];
    p += 2; // skip </status>, land on <value>

    p += 1;
    const value = lines[p];
    p += 2;
    const valueStatus = lines[p];
    p += 3; // skip to <vis>

    p += 1;
    const vis = lines[p];
    p += 2;
    const visStatus = lines[p];
    p += 3; // skip to <type>

    p += 1;
    const type = lines[p];
    p += 2;
    const typeStatus = lines[p];
    p += 3; // skip to the next, version-gated, field

    let comment = '';
    let commentStatus = 'GLOBAL_VAR';
    let color = -16777216;
    let colorStatus = 'GLOBAL_VAR';
    let useratts = '';
    let userattsStatus = 'GLOBAL_VAR';
    let resetval = '';
    let resetvalStatus = 'GLOBAL_VAR';

    if (ver >= 70925) {
      p += 1;
      comment = lines[p];
      p += 2;
      commentStatus = lines[p];
      p += 3;

      p += 1;
      color = Number(lines[p]);
      p += 2;
      colorStatus = lines[p];
      p += 3;
    }

    if (ver >= 110222) {
      p += 1;
      useratts = lines[p];
      p += 2;
      userattsStatus = lines[p];
      p += 3;
    }

    if (ver >= 110302) {
      p += 1;
      resetval = lines[p];
      p += 2;
      resetvalStatus = lines[p];
      p += 3;
    }

    p += 1;
    const x2Obj = Number(lines[p]);
    p += 2;

    p += 1;
    const y2Obj = Number(lines[p]);
    p += 2;

    p += 1;
    const page = Number(lines[p]);
    p += 2; // now at the closing tag, e.g. </name>

    result.push({
      name, nameStatus, value, valueStatus,
      visibility: Number(vis), visibilityStatus: visStatus,
      type, typeStatus, comment, commentStatus,
      color, colorStatus, useratts, userattsStatus,
      resetval, resetvalStatus, x2Obj, y2Obj, page,
    });

    s = p + 1;
  }

  return result;
}

function parseGlobals(list: string[], ver: number) {
  const mS = list.indexOf('<machine>') + 1;
  const mE = list.indexOf('</machine>') - 1;
  const iS = list.indexOf('<inputs>') + 1;
  const iE = list.indexOf('</inputs>') - 1;
  const oS = list.indexOf('<outputs>') + 1;
  const oE = list.indexOf('</outputs>') - 1;
  const sS = list.indexOf('<state>') + 1;
  const sE = list.indexOf('</state>') - 1;
  const tS = list.indexOf('<trans>') + 1;
  const tE = list.indexOf('</trans>') - 1;

  return {
    machine: readAttributeList(list, mS, mE, ver),
    inputs: readAttributeList(list, iS, iE, ver),
    outputs: readAttributeList(list, oS, oE, ver),
    stateAttrs: readAttributeList(list, sS, sE, ver),
    transAttrs: readAttributeList(list, tS, tE, ver),
  };
}

function readState(lines: string[], ver: number): FzmState {
  const startAttrIdx = lines.indexOf('<attributes>');
  const endAttrIdx = lines.indexOf('</attributes>');
  const attributes = readAttributeList(lines, startAttrIdx + 1, endAttrIdx - 1, ver);

  let p = endAttrIdx;
  p += 2;
  const x0 = Number(lines[p]);
  p += 3;
  const y0 = Number(lines[p]);
  p += 3;
  const x1 = Number(lines[p]);
  p += 3;
  const y1 = Number(lines[p]);
  p += 3;
  const reset = lines[p] === 'true';
  p += 3;
  const page = Number(lines[p]);

  let color = -16777216;
  if (ver >= 80316) {
    p += 3;
    color = Number(lines[p]);
  }

  const name = attributes[0]?.value ?? '';
  return { name, x0, y0, x1, y1, reset, page, color, attributes };
}

function readTransitionOrLoopback(lines: string[], ver: number): FzmTransition | FzmLoopback {
  const startAttrIdx = lines.indexOf('<attributes>');
  const endAttrIdx = lines.indexOf('</attributes>');
  const attributes = readAttributeList(lines, startAttrIdx + 1, endAttrIdx - 1, ver);

  let p = endAttrIdx;
  p += 2;
  const startState = lines[p];
  p += 3;
  const endState = lines[p];
  p += 3;
  const sX = Math.trunc(Number(lines[p]));
  p += 3;
  const sY = Math.trunc(Number(lines[p]));
  p += 3;
  const eX = Math.trunc(Number(lines[p]));
  p += 3;
  const eY = Math.trunc(Number(lines[p]));
  p += 3;
  const sCX = Math.trunc(Number(lines[p]));
  p += 3;
  const sCY = Math.trunc(Number(lines[p]));
  p += 3;
  const eCX = Math.trunc(Number(lines[p])); // written under the buggy <endCtrlPtY> tag in the file - see module comment
  p += 3;
  const eCY = Math.trunc(Number(lines[p]));
  p += 3;
  const startStateIndex = Number(lines[p]);
  p += 3;
  const endStateIndex = Number(lines[p]);
  p += 3;
  const page = Number(lines[p]);

  let color = -16777216;
  if (ver >= 80316) {
    p += 3;
    color = Number(lines[p]);
  }

  const startPt = { x: sX, y: sY };
  const endPt = { x: eX, y: eY };
  const startCtrlPt = { x: sCX, y: sCY };
  const endCtrlPt = { x: eCX, y: eCY };
  const name = attributes[0]?.value ?? '';

  if (startState === endState) {
    const loopback: FzmLoopback = {
      kind: 'loopback', name, state: startState,
      startPt, endPt, startCtrlPt, endCtrlPt,
      startStateIndex, endStateIndex, page, color, attributes,
    };
    return loopback;
  }

  p += 3;
  const pSx = Number(lines[p]);
  p += 3;
  const pSy = Number(lines[p]);
  p += 3;
  const pSCx = Number(lines[p]);
  p += 3;
  const pSCy = Number(lines[p]);
  p += 3;
  const pEx = Number(lines[p]);
  p += 3;
  const pEy = Number(lines[p]);
  p += 3;
  const pECx = Number(lines[p]);
  p += 3;
  const pECy = Number(lines[p]);
  p += 3;
  const stub = lines[p] === 'true';

  const transition: FzmTransition = {
    kind: 'transition', name, startState, endState,
    startPt, endPt, startCtrlPt, endCtrlPt,
    startStateIndex, endStateIndex, page, color,
    pageS: { x: pSx, y: pSy }, pageSC: { x: pSCx, y: pSCy },
    pageE: { x: pEx, y: pEy }, pageEC: { x: pECx, y: pECy },
    stub, attributes,
  };
  return transition;
}

function readText(lines: string[]): FzmText {
  const text = lines[0] ?? '';
  const x = Number(lines[2]);
  const y = Number(lines[5]);
  const page = Number(lines[8]);
  const isGlobalTable = text === 'fzm_globalTable';
  return { text: isGlobalTable ? null : text, isGlobalTable, x, y, page };
}

export function parseFzm(content: string): FzmDocument {
  const rawLines = content.split(/\r\n|\r|\n/);
  const lines = rawLines.map((l) => l.replace(/^ +/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  let pos = 0;
  const next = (): string | null => (pos < lines.length ? lines[pos++] : null);

  let ver = 0;
  let version = '';
  let machine: ObjAttribute[] = [];
  let inputs: ObjAttribute[] = [];
  let outputs: ObjAttribute[] = [];
  let stateAttrs: ObjAttribute[] = [];
  let transAttrs: ObjAttribute[] = [];
  const tabs: string[] = [];
  const states: FzmState[] = [];
  const transitions: (FzmTransition | FzmLoopback)[] = [];
  const texts: FzmText[] = [];
  const preferences: FzmPreferences = { ...DEFAULT_PREFERENCES };

  const readBlock = (closeTag: string): string[] => {
    const block: string[] = [];
    let l: string | null;
    while ((l = next()) !== null && l !== closeTag) {
      if (l.startsWith('##')) continue;
      block.push(l);
    }
    return block;
  };

  let line: string | null;
  while ((line = next()) !== null) {
    if (line.startsWith('##')) continue;

    if (line === '<version>') {
      version = readSimpleValue(next);
      ver = Number(version.replace(/\./g, ''));
    } else if (line === '<globals>') {
      const g = parseGlobals(readBlock('</globals>'), ver);
      machine = g.machine;
      inputs = g.inputs;
      outputs = g.outputs;
      stateAttrs = g.stateAttrs;
      transAttrs = g.transAttrs;
    } else if (line === '<state>') {
      states.push(readState(readBlock('</state>'), ver));
    } else if (line === '<transition>') {
      transitions.push(readTransitionOrLoopback(readBlock('</transition>'), ver));
    } else if (line === '<textObj>') {
      texts.push(readText(readBlock('</textObj>')));
    } else if (line === '<tabs>') {
      let l: string | null;
      while ((l = next()) !== null && l !== '</tabs>') {
        if (l.startsWith('##')) continue;
        tabs.push(l);
      }
    } else if (line === '<SCounter>') {
      preferences.sCounter = Number(readBlock('</SCounter>')[0]);
    } else if (line === '<TCounter>') {
      preferences.tCounter = Number(readBlock('</TCounter>')[0]);
    } else if (line === '<TableVis>') {
      preferences.tableVis = readBlock('</TableVis>')[0] === 'true';
    } else if (line === '<TableSpace>') {
      preferences.tableSpace = Number(readBlock('</TableSpace>')[0]);
    } else if (line === '<TableFont>') {
      const b = readBlock('</TableFont>');
      preferences.tableFontName = b[0];
      preferences.tableFontSize = Number(b[1]);
    } else if (line === '<TableColor>') {
      preferences.tableColor = Number(readBlock('</TableColor>')[0]);
    } else if (line === '<Font>') {
      const b = readBlock('</Font>');
      preferences.fontName = b[0];
      preferences.fontSize = Number(b[1]);
    } else if (line === '<Grid>') {
      const b = readBlock('</Grid>');
      preferences.grid = b[0] === 'true';
      preferences.gridSize = Number(b[1]);
    } else if (line === '<PageSizeW>') {
      preferences.pageSizeW = Number(readBlock('</PageSizeW>')[0]);
    } else if (line === '<PageSizeH>') {
      preferences.pageSizeH = Number(readBlock('</PageSizeH>')[0]);
    } else if (line === '<StateW>') {
      preferences.stateW = Number(readBlock('</StateW>')[0]);
    } else if (line === '<StateH>') {
      preferences.stateH = Number(readBlock('</StateH>')[0]);
    } else if (line === '<LineWidth>') {
      preferences.lineWidth = Number(readBlock('</LineWidth>')[0]);
    } else if (line === '<CustomArgs>') {
      preferences.customArgs = readBlock('</CustomArgs>')[0] ?? '';
    }
  }

  return { version, versionInt: ver, machine, inputs, outputs, stateAttrs, transAttrs, tabs, preferences, states, transitions, texts };
}
