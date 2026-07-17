import { FzmDocument, ObjAttribute } from '../fzm/model';
import { hexToColorInt } from './edit';

// Ports GlobalProperties (Properties.java): declaring/renaming/deleting inputs
// and outputs, adding a reset signal/state, editing machine values, and — via
// reconcileGlobals below — the full GeneralObj.updateAttrib reconciliation that
// Fizzim runs on every object after the Global Attributes dialog closes. Adding
// an output also creates a matching type="output" attribute in the States
// global list, mirrored into each state so per-state output values exist.

// The 5 global lists, by index (matches the file format and GlobalProperties).
export const MACHINE = 0;
export const INPUTS = 1;
export const OUTPUTS = 2;
export const STATE_ATTRS = 3;
export const TRANS_ATTRS = 4;

export type OutputType = 'comb' | 'reg' | 'regdp' | 'flag';

export function globalList(doc: FzmDocument, index: number): ObjAttribute[] {
  return [doc.machine, doc.inputs, doc.outputs, doc.stateAttrs, doc.transAttrs][index];
}

function makeGlobalAttr(
  name: string,
  value: string,
  visibility: number,
  type: string,
  nameStatus: string,
  useratts = ''
): ObjAttribute {
  return {
    name,
    nameStatus,
    value,
    valueStatus: 'GLOBAL_VAR',
    visibility,
    visibilityStatus: 'GLOBAL_VAR',
    type,
    typeStatus: 'GLOBAL_VAR',
    comment: '',
    commentStatus: 'GLOBAL_VAR',
    color: -16777216,
    colorStatus: 'GLOBAL_VAR',
    useratts,
    userattsStatus: 'GLOBAL_VAR',
    resetval: '',
    resetvalStatus: 'GLOBAL_VAR',
    x2Obj: 0,
    y2Obj: 0,
    page: -1,
  };
}

function uniqueName(list: ObjAttribute[], base: string): string {
  if (!list.some((a) => a.name === base)) return base;
  let n = 1;
  while (list.some((a) => a.name === `${base}${n}`)) n++;
  return `${base}${n}`;
}

export function addInput(doc: FzmDocument, multibit = false): ObjAttribute {
  const name = uniqueName(doc.inputs, multibit ? 'in[1:0]' : 'in');
  const attr = makeGlobalAttr(name, '', 0, '', 'GLOBAL_FIXED');
  doc.inputs.push(attr);
  return attr;
}

export function addOutput(doc: FzmDocument, type: OutputType = 'reg', multibit = false): ObjAttribute {
  const base = type === 'flag' ? 'flag' : multibit ? 'out[1:0]' : 'out';
  const name = uniqueName(doc.outputs, base);
  const vis = 2; // NONDEFAULT, matching Java's new-output visibility
  const useratts = type === 'flag' ? 'suppress_portlist' : '';
  // Flags can't have default values; other outputs default to "0" so codegen
  // succeeds immediately (fizzim.pl requires a value or default for reg/comb
  // outputs). The user can change the default in the outputs table.
  const defaultValue = type === 'flag' ? '' : '0';
  const out = makeGlobalAttr(name, defaultValue, vis, type, 'GLOBAL_FIXED', useratts);
  doc.outputs.push(out);

  // Mirror into the States global list and every state (type "output"). Seed
  // per-state values to the output's default (not "") so a state reads as "at
  // default" unless explicitly overridden — otherwise fizzim.pl treats an empty
  // value as a non-default per-state assignment, which conflicts with using the
  // same output on a transition (Mealy).
  const stateGlobal = makeGlobalAttr(name, defaultValue, vis, 'output', 'GLOBAL_FIXED');
  doc.stateAttrs.push(stateGlobal);
  for (const s of doc.states) {
    s.attributes.push(makeGlobalAttr(name, defaultValue, vis, 'output', 'GLOBAL_FIXED'));
  }
  return out;
}

export function addReset(doc: FzmDocument): void {
  if (!doc.machine.some((a) => a.name === 'reset_signal')) {
    doc.machine.push(makeGlobalAttr('reset_signal', 'resetN', 0, 'negedge', 'ABS'));
  }
  if (!doc.machine.some((a) => a.name === 'reset_state')) {
    const defaultState = doc.states[0]?.name ?? '';
    doc.machine.push(makeGlobalAttr('reset_state', defaultState, 0, 'allzeros', 'ABS'));
  }
}

// True if the attribute is a built-in that must not be renamed/deleted.
export function isProtected(attr: ObjAttribute): boolean {
  return attr.nameStatus === 'ABS';
}

// True once the machine already has both a reset signal and a reset state, so
// the Machine tab's "Add Reset" button can grey out (Java disables it).
export function hasReset(doc: FzmDocument): boolean {
  return doc.machine.some((a) => a.name === 'reset_signal') && doc.machine.some((a) => a.name === 'reset_state');
}

// Adds a user-defined attribute to a global list (Fizzim's "User" button). On
// States/Transitions it's mirrored into every state/transition. On Inputs it
// adds a plain signal; on Outputs a reg output (mirrored into states) — matching
// Java's GPOption2, which adds a blank row and presets type=reg on the outputs
// tab. Machine adds a plain machine attribute.
export function addUserAttribute(doc: FzmDocument, listIndex: number): ObjAttribute {
  if (listIndex === INPUTS) return addInput(doc, false);
  if (listIndex === OUTPUTS) return addOutput(doc, 'reg', false);
  const list = globalList(doc, listIndex);
  const name = uniqueName(list, 'attr');
  const attr = makeGlobalAttr(name, '', 1, '', 'GLOBAL_FIXED');
  list.push(attr);
  if (listIndex === STATE_ATTRS) {
    for (const s of doc.states) s.attributes.push(makeGlobalAttr(name, '', 1, '', 'GLOBAL_FIXED'));
  } else if (listIndex === TRANS_ATTRS) {
    for (const t of doc.transitions) t.attributes.push(makeGlobalAttr(name, '', 1, '', 'GLOBAL_FIXED'));
  }
  return attr;
}

// Validates a proposed Outputs-tab cell edit against Fizzim's rules
// (MyTableModel.setValueAt): only regdp/flag outputs may carry a reset value,
// and flag outputs cannot have a default value. Returns an error string to
// reject the edit, or null to allow it. `col` is 1=value, 3=type, 7=resetval.
export function validateOutputEdit(attr: ObjAttribute, col: number, value: string): string | null {
  const type = col === 3 ? value : attr.type;
  const resetval = col === 7 ? value : attr.resetval;
  const defaultVal = col === 1 ? value : attr.value;
  if (resetval !== '' && type !== 'flag' && type !== 'regdp') {
    return 'Only regdp and flag can have a reset value';
  }
  if (defaultVal !== '' && type === 'flag') {
    return 'Flags cannot have default values';
  }
  return null;
}

// Fizzim's Transitions-tab "Priority" / "Graycode" buttons. Each adds a single
// global transition attribute (idempotent — Fizzim disables the button once it
// exists) and mirrors it onto every transition. Priority defaults to "1000",
// graycode to "" (like Properties.java). Both are visible (vis 1), so priority
// shows on the canvas by default — matching Fizzim.
function addSingletonTransAttr(doc: FzmDocument, name: string, value: string): boolean {
  if (doc.transAttrs.some((a) => a.name === name)) return false;
  doc.transAttrs.push(makeGlobalAttr(name, value, 1, '', 'GLOBAL_FIXED'));
  for (const t of doc.transitions) {
    if (!t.attributes.some((a) => a.name === name)) {
      t.attributes.push(makeGlobalAttr(name, value, 1, '', 'GLOBAL_FIXED'));
    }
  }
  return true;
}

export function hasTransAttr(doc: FzmDocument, name: string): boolean {
  return doc.transAttrs.some((a) => a.name === name);
}

export function addPriority(doc: FzmDocument): boolean {
  return addSingletonTransAttr(doc, 'priority', '1000');
}

export function addGraycode(doc: FzmDocument): boolean {
  return addSingletonTransAttr(doc, 'graycode', '');
}

// Outputs appear (as type="output") in the States list too; they must be
// managed from the Outputs tab, not the States tab.
function isOutputMirror(listIndex: number, attr: ObjAttribute): boolean {
  return listIndex === STATE_ATTRS && attr.type === 'output';
}

export function deleteGlobalAttr(doc: FzmDocument, listIndex: number, index: number): void {
  const list = globalList(doc, listIndex);
  const attr = list[index];
  if (!attr || isProtected(attr) || isOutputMirror(listIndex, attr)) return;
  const name = attr.name;
  list.splice(index, 1);
  if (listIndex === OUTPUTS) {
    removeByName(doc.stateAttrs, name);
    for (const s of doc.states) removeByName(s.attributes, name);
  } else if (listIndex === STATE_ATTRS) {
    for (const s of doc.states) removeByName(s.attributes, name);
  } else if (listIndex === TRANS_ATTRS) {
    for (const t of doc.transitions) removeByName(t.attributes, name);
  }
}

function removeByName(list: ObjAttribute[], name: string): void {
  const i = list.findIndex((a) => a.name === name);
  if (i >= 0) list.splice(i, 1);
}

export function renameGlobalAttr(doc: FzmDocument, listIndex: number, index: number, newName: string): { ok: boolean; error?: string } {
  newName = newName.trim();
  const list = globalList(doc, listIndex);
  const attr = list[index];
  if (!attr) return { ok: false, error: 'No such attribute.' };
  if (isProtected(attr)) return { ok: false, error: `"${attr.name}" cannot be renamed.` };
  if (isOutputMirror(listIndex, attr)) return { ok: false, error: 'Rename this output in the Outputs tab.' };
  if (!newName) return { ok: false, error: 'Name cannot be empty.' };
  if (list.some((a, i) => i !== index && a.name === newName)) return { ok: false, error: `"${newName}" already exists in this list.` };

  const oldName = attr.name;
  attr.name = newName;
  if (listIndex === OUTPUTS) {
    renameByName(doc.stateAttrs, oldName, newName);
    for (const s of doc.states) renameByName(s.attributes, oldName, newName);
  } else if (listIndex === STATE_ATTRS) {
    for (const s of doc.states) renameByName(s.attributes, oldName, newName);
  } else if (listIndex === TRANS_ATTRS) {
    for (const t of doc.transitions) renameByName(t.attributes, oldName, newName);
  }
  return { ok: true };
}

function renameByName(list: ObjAttribute[], oldName: string, newName: string): void {
  const a = list.find((x) => x.name === oldName);
  if (a) a.name = newName;
}

export function setGlobalAttrField(
  attr: ObjAttribute,
  field: 'value' | 'type' | 'visibility' | 'comment' | 'color' | 'useratts' | 'resetval',
  value: string
): void {
  if (field === 'visibility') attr.visibility = Number(value) || 0;
  else if (field === 'color') attr.color = hexToColorInt(value);
  else attr[field] = value;
}

// --- Global reconciliation (ports GeneralObj.updateAttrib) -----------------
// After the Global Attributes dialog closes, Fizzim reconciles every state and
// transition's private attribute copies against the (possibly edited) global
// lists: non-LOCAL fields are refreshed from the global default, a per-object
// LOCAL override reverts to the default when it now equals it, rows are added /
// removed / reordered to match the global list, and each attribute's page is
// assigned if unset. We reproduce that here so editing an output's default (or
// any global field) actually reaches the objects — otherwise stale per-state
// copies silently drive the generated HDL.

// The value-carrying columns 0..6 (name..useratts) that updateAttrib copies
// from global into a non-LOCAL local field. Column 7 (resetval) is deliberately
// excluded, matching Java's `for(j=0;j<7;j++)` loop.
const COPY_FIELDS: (keyof ObjAttribute)[] = ['name', 'value', 'visibility', 'type', 'comment', 'color', 'useratts'];
const COPY_STATUS: (keyof ObjAttribute)[] = [
  'nameStatus', 'valueStatus', 'visibilityStatus', 'typeStatus', 'commentStatus', 'colorStatus', 'userattsStatus',
];

// Ports GeneralObj.updateAttrib(glist, a) for a single object's attribute list.
function updateAttrib(objName: string, attrib: ObjAttribute[], global: ObjAttribute[], objPage: number): void {
  for (let i = 0; i < global.length; i++) {
    const g = global[i];
    const l = i < attrib.length ? attrib[i] : null;
    if (l && g.name === l.name) {
      // A global attribute's name can't be a local override.
      if (l.nameStatus === 'LOCAL') l.nameStatus = 'GLOBAL_FIXED';
      // A blank value/type is treated as "follows the global default".
      if (l.value === '') l.valueStatus = 'GLOBAL_VAR';
      if (l.type === '') l.typeStatus = 'GLOBAL_VAR';
      // Refresh every non-LOCAL value column from the global default.
      for (let j = 0; j < COPY_FIELDS.length; j++) {
        if ((l[COPY_STATUS[j]] as string) !== 'LOCAL') {
          (l[COPY_FIELDS[j]] as ObjAttribute[keyof ObjAttribute]) = g[COPY_FIELDS[j]];
        }
      }
      // A per-object override that now equals the default is no longer an override.
      if (l.valueStatus === 'LOCAL' && g.value === l.value) l.valueStatus = 'GLOBAL_VAR';
    } else {
      // Names differ at this index: look for g elsewhere in the local list and
      // move it into position; otherwise clone the global into place.
      let found = false;
      for (let k = 0; k < attrib.length; k++) {
        if (g.name === attrib[k].name) {
          if (i < attrib.length) {
            attrib.push(attrib[i]);
            attrib[i] = attrib[k];
            attrib.splice(k, 1);
          }
          found = true;
          break;
        }
      }
      if (!found) {
        const cloned = structuredClone(g);
        if (cloned.name === 'name') {
          cloned.value = objName;
          cloned.valueStatus = 'LOCAL';
        }
        attrib.splice(i, 0, cloned);
      }
    }
  }
  // Drop any non-LOCAL attributes that were removed from the global list.
  if (attrib.length > global.length) {
    for (let i = attrib.length - 1; i > global.length - 1; i--) {
      if (attrib[i].nameStatus !== 'LOCAL') attrib.splice(i, 1);
    }
  }
  // Assign a page to any attribute that doesn't have one yet (Java's
  // setPage(i,"update") only fills a page of -1, so existing label page
  // assignments — e.g. a label moved to another page — are preserved).
  for (const l of attrib) if (l.page === -1) l.page = objPage;
}

// Re-syncs every object after a Global Attributes edit (ports DrawArea's
// updateStates + updateTrans + the outputs->states mirror sync).
export function reconcileGlobals(doc: FzmDocument): void {
  // Sync each output's edited columns into its States-list mirror entry (Java's
  // renameAttribute(3,...)), so the new default/vis/etc. flows on into states.
  // The mirror keeps type "output"; only the value-carrying fields track it.
  for (const o of doc.outputs) {
    const mirror = doc.stateAttrs.find((a) => a.name === o.name && a.type === 'output');
    if (mirror) {
      mirror.value = o.value;
      mirror.visibility = o.visibility;
      mirror.comment = o.comment;
      mirror.color = o.color;
      mirror.useratts = o.useratts;
      mirror.resetval = o.resetval;
    }
  }
  for (const s of doc.states) updateAttrib(s.name, s.attributes, doc.stateAttrs, s.page);
  for (const t of doc.transitions) updateAttrib(t.name, t.attributes, doc.transAttrs, t.page);
  // The reset ring follows the machine's reset_state value (DrawArea.updateStates).
  const resetState = doc.machine.find((a) => a.name === 'reset_state');
  const resetName = resetState ? resetState.value : null;
  for (const s of doc.states) s.reset = resetName != null && resetName !== '' && s.name === resetName;
}
