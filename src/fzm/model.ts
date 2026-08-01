export interface Point {
  x: number;
  y: number;
}

export interface ObjAttribute {
  name: string;
  nameStatus: string;
  value: string;
  valueStatus: string;
  visibility: number;
  visibilityStatus: string;
  type: string;
  typeStatus: string;
  comment: string;
  commentStatus: string;
  color: number;
  colorStatus: string;
  useratts: string;
  userattsStatus: string;
  resetval: string;
  resetvalStatus: string;
  x2Obj: number;
  y2Obj: number;
  page: number;
}

export interface FzmState {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reset: boolean;
  page: number;
  color: number;
  attributes: ObjAttribute[];
}

export interface FzmTransition {
  kind: 'transition';
  name: string;
  startState: string;
  endState: string;
  startPt: Point;
  endPt: Point;
  startCtrlPt: Point;
  endCtrlPt: Point;
  startStateIndex: number;
  endStateIndex: number;
  page: number;
  color: number;
  pageS: Point;
  pageSC: Point;
  pageE: Point;
  pageEC: Point;
  stub: boolean;
  // Java's StateTransitionObj.len/angle, only meaningful while `stub` is set.
  // Java derives them ONCE when a file loads (StateTransitionObj.java:175-179)
  // and thereafter only rewrites them when the user drags a stub handle;
  // moveEndPts' stub branch (:443-444) rebuilds pageS from these stored values,
  // which is what makes a Java stub keep its exact length across any number of
  // state moves. Deliberately NOT serialized - Java doesn't persist them
  // either, so they are re-derived on the next parse (see recomputeStub).
  stubLen?: number;
  stubAngle?: number;
  attributes: ObjAttribute[];
}

export interface FzmLoopback {
  kind: 'loopback';
  name: string;
  state: string;
  startPt: Point;
  endPt: Point;
  startCtrlPt: Point;
  endCtrlPt: Point;
  startStateIndex: number;
  endStateIndex: number;
  page: number;
  color: number;
  attributes: ObjAttribute[];
}

export interface FzmText {
  text: string | null;
  isGlobalTable: boolean;
  x: number;
  y: number;
  page: number;
}

// The <SCounter>...<LineWidth> preferences block. Captured so we can write it
// back on save; values default to Fizzim's own defaults when a tag is absent
// (e.g. older files omit <LineWidth>).
export interface FzmPreferences {
  sCounter: number;
  tCounter: number;
  tableVis: boolean;
  tableSpace: number;
  tableFontName: string;
  tableFontSize: number;
  tableColor: number;
  fontName: string;
  fontSize: number;
  grid: boolean;
  gridSize: number;
  pageSizeW: number;
  pageSizeH: number;
  stateW: number;
  stateH: number;
  lineWidth: number;
  // Extra command-line args appended to the fizzim.pl invocation (e.g.
  // "-encoding onehot"). Not part of the original Fizzim format - our own
  // addition, so unknown tags are safely ignored by both the Java reader and
  // fizzim.pl's own parser.
  customArgs: string;
}

export const DEFAULT_PREFERENCES: FzmPreferences = {
  sCounter: 0,
  tCounter: 0,
  tableVis: true,
  tableSpace: 20,
  tableFontName: 'Arial',
  tableFontSize: 11,
  tableColor: -16777216,
  fontName: 'Arial',
  fontSize: 11,
  grid: false,
  gridSize: 25,
  pageSizeW: 936,
  pageSizeH: 1296,
  stateW: 130,
  stateH: 130,
  lineWidth: 1,
  customArgs: '',
};

export interface FzmDocument {
  version: string;
  versionInt: number;
  machine: ObjAttribute[];
  inputs: ObjAttribute[];
  outputs: ObjAttribute[];
  stateAttrs: ObjAttribute[];
  transAttrs: ObjAttribute[];
  tabs: string[];
  preferences: FzmPreferences;
  states: FzmState[];
  transitions: (FzmTransition | FzmLoopback)[];
  texts: FzmText[];
}

function attr(name: string, value: string, visibility: number, type: string, nameStatus: string): ObjAttribute {
  return {
    name, nameStatus, value, valueStatus: 'GLOBAL_VAR',
    visibility, visibilityStatus: 'GLOBAL_VAR', type, typeStatus: 'GLOBAL_VAR',
    comment: '', commentStatus: 'GLOBAL_VAR', color: -16777216, colorStatus: 'GLOBAL_VAR',
    useratts: '', userattsStatus: 'GLOBAL_VAR', resetval: '', resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0, y2Obj: 0, page: -1,
  };
}

// A fresh, empty-but-valid Fizzim document (mirrors what the Java GUI starts
// with): machine name + clock, the reserved state/trans "name"/"equation"
// globals, one page, and the on-canvas global table. The user then draws states.
export function defaultDocument(): FzmDocument {
  return {
    version: '14.02.28',
    versionInt: 140228,
    machine: [attr('name', 'def_name', 0, '', 'ABS'), attr('clock', 'clk', 0, 'posedge', 'ABS')],
    inputs: [],
    outputs: [],
    stateAttrs: [attr('name', 'def_name', 1, 'def_type', 'ABS')],
    transAttrs: [attr('name', 'def_name', 0, 'def_type', 'ABS'), attr('equation', '1', 1, 'def_type', 'ABS')],
    tabs: ['Page 1'],
    preferences: { ...DEFAULT_PREFERENCES },
    states: [],
    transitions: [],
    texts: [{ text: null, isGlobalTable: true, x: 10, y: 10, page: 1 }],
  };
}
