// The full attribute-table property dialog, mirroring Fizzim's
// StateProperties / TransProperties. Native dialogs don't work in a VS Code
// webview, so this is a DOM modal. It shows every attribute in an 8-column
// table (Name/Value/Visibility/Type/Comment/Color/UserAtts/ResetValue) with
// per-cell editability driven by each attribute's status, plus object-level
// "extra" fields (width/height for a state; start/end/stub for a transition;
// a color swatch for both).

import { ObjAttribute } from '../fzm/model';
import { AttrRowEdit, attrCellEditable, attrColValue, colorIntToHex, hexToColorInt, newLocalAttribute } from './edit';
import { Field, FormResult } from './formDialog';

const VIS_LABELS = ['No', 'Yes', 'Only non-default'];

// "reg" is stored internally but shown as "statebit" (Java's getValueAt/setValueAt).
function typeToDisplay(t: string): string {
  return t === 'reg' ? 'statebit' : t;
}
function typeFromDisplay(t: string): string {
  return t === 'statebit' ? 'reg' : t;
}

function styleButton(btn: HTMLButtonElement, primary: boolean): void {
  btn.style.padding = '4px 12px';
  btn.style.cursor = 'pointer';
  btn.style.border = 'none';
  btn.style.color = primary ? 'var(--vscode-button-foreground, #fff)' : 'var(--vscode-button-secondaryForeground, #ccc)';
  btn.style.background = primary ? 'var(--vscode-button-background, #0e639c)' : 'var(--vscode-button-secondaryBackground, #3a3d41)';
}

const INPUT_CSS = 'background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#3c3c3c);';

// Sizes a table-cell input to its content instead of a fixed pixel width, so a
// long state/attribute name isn't clipped inside its own cell: it starts at
// minCh (already larger than the old fixed widths), grows on every keystroke,
// and caps at maxCh so one huge value can't blow out the table - the dialog's
// box already scrolls (max-width:90vw; overflow:auto), so a value past the cap
// is still fully editable, just scrolled within its cell rather than resized.
function sizeToContent(inp: HTMLInputElement, minCh: number, maxCh: number): void {
  const size = () => { inp.style.width = `${Math.min(maxCh, Math.max(minCh, inp.value.length + 1))}ch`; };
  size();
  inp.addEventListener('input', size);
}

// Appends a small "Black" button next to a color picker that resets it to
// Fizzim's default (#000000). Mirrors the one showForm adds (STEP 11) so the
// state/transition dialogs get the same reset affordance.
function appendBlackReset(container: HTMLElement, colorInput: HTMLInputElement): void {
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Black';
  resetBtn.style.cssText = 'margin-left:4px;padding:2px 8px;cursor:pointer;border:none;color:var(--vscode-button-secondaryForeground,#ccc);background:var(--vscode-button-secondaryBackground,#3a3d41);';
  resetBtn.addEventListener('click', () => { colorInput.value = '#000000'; });
  container.appendChild(resetBtn);
}

export interface AttrDialogResult {
  rows: AttrRowEdit[]; // edits for the original attributes, by their original index
  extras: FormResult;
  added: ObjAttribute[]; // brand-new local attributes to append to the object
  removedNames: string[]; // names of local attributes the user deleted
}

export function showAttributeDialog(
  title: string,
  attributes: ObjAttribute[],
  extraFields: Field[] = []
): Promise<AttrDialogResult | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:2000;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-editorWidget-foreground,#ccc);' +
      'border:1px solid var(--vscode-editorWidget-border,#454545);padding:16px;max-width:90vw;max-height:88vh;overflow:auto;' +
      'font-family:var(--vscode-font-family,sans-serif);font-size:13px;box-shadow:0 2px 12px rgba(0,0,0,0.4);';

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'font-weight:bold;margin-bottom:12px;';
    box.appendChild(heading);

    // --- the attribute table -------------------------------------------------
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;margin-bottom:12px;';
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const label of ['Attribute Name', 'Value', 'Visibility', 'Type', 'Comment', 'Color', 'UserAtts', 'ResetValue']) {
      const th = document.createElement('th');
      th.textContent = label;
      th.style.cssText =
        'text-align:left;padding:3px 6px;border:1px solid var(--vscode-editorWidget-border,#454545);' +
        'background:var(--vscode-editorWidget-background,#252526);font-weight:600;white-space:nowrap;';
      hrow.appendChild(th);
    }
    // Trailing actions column (per-row delete for local attributes).
    const actTh = document.createElement('th');
    actTh.style.cssText = 'border:1px solid var(--vscode-editorWidget-border,#454545);background:var(--vscode-editorWidget-background,#252526);';
    hrow.appendChild(actTh);
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    // The working set of displayed rows. Originals reference the passed
    // attributes (OK returns their edits by original index); rows added this
    // session carry origIndex null. Deleting a local original records its name
    // to remove on OK (Fizzim's SPNew/SPDelete / TPNew/TPDelete).
    type WorkRow = { attr: ObjAttribute; origIndex: number | null };
    type Ctl = {
      row: WorkRow;
      name?: HTMLInputElement;
      value?: HTMLInputElement;
      visibility?: HTMLSelectElement;
      type?: HTMLInputElement;
      comment?: HTMLInputElement;
      color?: HTMLInputElement;
      useratts?: HTMLInputElement;
      resetval?: HTMLInputElement;
    };
    const working: WorkRow[] = attributes.map((a, index) => ({ attr: a, origIndex: index }));
    const removedNames = new Set<string>();
    const rowCtl: Ctl[] = [];

    const uniqueAttrName = (): string => {
      const taken = new Set(working.map((w) => w.attr.name));
      if (!taken.has('attr')) return 'attr';
      let n = 1;
      while (taken.has(`attr${n}`)) n++;
      return `attr${n}`;
    };

    const buildRow = (row: WorkRow): void => {
      const a = row.attr;
      const isNew = row.origIndex === null;
      const tr = document.createElement('tr');
      const ctl: Ctl = { row };
      rowCtl.push(ctl);

      const cell = () => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:2px 4px;border:1px solid var(--vscode-editorWidget-border,#454545);';
        tr.appendChild(td);
        return td;
      };

      // 0: Attribute Name — editable for a freshly added row and for any LOCAL
      // attribute (Java's isCellEditable lets you rename ones you added);
      // global rows stay labels (rename those via the Global dialog).
      const nameTd = cell();
      if (isNew || a.nameStatus === 'LOCAL') {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = a.name;
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 16, 40);
        nameTd.appendChild(inp);
        ctl.name = inp;
      } else {
        nameTd.textContent = a.name;
        nameTd.style.whiteSpace = 'nowrap';
        nameTd.style.color = 'var(--vscode-descriptionForeground,#bbb)';
      }

      // 1: Value
      const valueTd = cell();
      if (attrCellEditable(a, 1)) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = a.value;
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 18, 60);
        valueTd.appendChild(inp);
        ctl.value = inp;
      } else {
        valueTd.textContent = a.value;
      }

      // 2: Visibility (dropdown No/Yes/Only non-default)
      const visTd = cell();
      if (attrCellEditable(a, 2)) {
        const sel = document.createElement('select');
        sel.style.cssText = 'padding:2px;' + INPUT_CSS;
        VIS_LABELS.forEach((lbl, i) => {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = lbl;
          if (i === a.visibility) o.selected = true;
          sel.appendChild(o);
        });
        visTd.appendChild(sel);
        ctl.visibility = sel;
      } else {
        visTd.textContent = VIS_LABELS[a.visibility] ?? String(a.visibility);
      }

      // 3: Type (free text; reg<->statebit display)
      const typeTd = cell();
      if (attrCellEditable(a, 3)) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = typeToDisplay(a.type);
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 10, 24);
        typeTd.appendChild(inp);
        ctl.type = inp;
      } else {
        typeTd.textContent = typeToDisplay(a.type);
      }

      // 4: Comment
      const commentTd = cell();
      if (attrCellEditable(a, 4)) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = a.comment;
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 16, 50);
        commentTd.appendChild(inp);
        ctl.comment = inp;
      } else {
        commentTd.textContent = a.comment;
      }

      // 5: Color (swatch / native picker)
      const colorTd = cell();
      if (attrCellEditable(a, 5)) {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = colorIntToHex(a.color);
        inp.style.cssText = 'width:28px;height:22px;padding:0;border:1px solid var(--vscode-input-border,#3c3c3c);cursor:pointer;background:none;';
        colorTd.appendChild(inp);
        appendBlackReset(colorTd, inp);
        ctl.color = inp;
      } else {
        const sw = document.createElement('span');
        sw.style.cssText = `display:inline-block;width:24px;height:16px;border:1px solid #000;background:${colorIntToHex(a.color)};`;
        colorTd.appendChild(sw);
      }

      // 6: UserAtts
      const userTd = cell();
      if (attrCellEditable(a, 6)) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = a.useratts;
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 12, 40);
        userTd.appendChild(inp);
        ctl.useratts = inp;
      } else {
        userTd.textContent = a.useratts;
      }

      // 7: ResetValue
      const resetTd = cell();
      if (attrCellEditable(a, 7)) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = a.resetval;
        inp.style.cssText = 'padding:2px 4px;outline:none;' + INPUT_CSS;
        sizeToContent(inp, 10, 30);
        resetTd.appendChild(inp);
        ctl.resetval = inp;
      } else {
        resetTd.textContent = a.resetval;
      }

      // 8: actions — delete a per-object local attribute (nameStatus LOCAL).
      const actTd = cell();
      if (a.nameStatus === 'LOCAL') {
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'Delete this attribute';
        del.style.cssText = 'padding:1px 6px;cursor:pointer;border:none;color:var(--vscode-button-secondaryForeground,#ccc);background:var(--vscode-button-secondaryBackground,#3a3d41);';
        del.addEventListener('click', () => {
          if (row.origIndex !== null) removedNames.add(a.name);
          const idx = working.indexOf(row);
          if (idx >= 0) working.splice(idx, 1);
          renderRows();
        });
        actTd.appendChild(del);
      }

      tbody.appendChild(tr);
    };

    const renderRows = (): void => {
      tbody.innerHTML = '';
      rowCtl.length = 0;
      for (const row of working) buildRow(row);
    };
    renderRows();
    table.appendChild(tbody);
    box.appendChild(table);

    // "New Attribute" — add a local attribute to this object (Fizzim SPNew/TPNew).
    const newAttrBtn = document.createElement('button');
    newAttrBtn.type = 'button';
    newAttrBtn.textContent = '+ New Attribute';
    styleButton(newAttrBtn, false);
    newAttrBtn.style.marginBottom = '12px';
    newAttrBtn.addEventListener('click', () => {
      working.push({ attr: newLocalAttribute(uniqueAttrName()), origIndex: null });
      renderRows();
    });
    box.appendChild(newAttrBtn);

    // --- extra object-level fields (width/height/start/end/stub/color) -------
    const extraInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    if (extraFields.length > 0) {
      const extraWrap = document.createElement('div');
      extraWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:12px;';
      for (const field of extraFields) {
        const group = document.createElement('div');
        group.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
        if (field.kind === 'checkbox') {
          const label = document.createElement('label');
          label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
          const inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.checked = field.value;
          label.appendChild(inp);
          label.appendChild(document.createTextNode(field.label));
          group.appendChild(label);
          extraInputs.set(field.key, inp);
        } else {
          const lbl = document.createElement('div');
          lbl.textContent = field.label;
          lbl.style.cssText = 'color:var(--vscode-descriptionForeground,#bbb);';
          group.appendChild(lbl);
          if (field.kind === 'select') {
            const sel = document.createElement('select');
            sel.style.cssText = 'padding:3px;' + INPUT_CSS;
            for (const opt of field.options) {
              const o = document.createElement('option');
              o.value = opt;
              o.textContent = opt;
              if (opt === field.value) o.selected = true;
              sel.appendChild(o);
            }
            group.appendChild(sel);
            extraInputs.set(field.key, sel);
          } else if (field.kind === 'color') {
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.value = field.value;
            inp.style.cssText = 'width:40px;height:26px;padding:0;border:1px solid var(--vscode-input-border,#3c3c3c);cursor:pointer;background:none;';
            const colorRow = document.createElement('div');
            colorRow.style.cssText = 'display:flex;align-items:center;';
            colorRow.appendChild(inp);
            appendBlackReset(colorRow, inp);
            group.appendChild(colorRow);
            extraInputs.set(field.key, inp);
          } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = field.value;
            inp.style.cssText = 'padding:3px 5px;outline:none;' + INPUT_CSS;
            sizeToContent(inp, 10, 30);
            group.appendChild(inp);
            extraInputs.set(field.key, inp);
          }
        }
        extraWrap.appendChild(group);
      }
      box.appendChild(extraWrap);
    }

    // --- buttons -------------------------------------------------------------
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    styleButton(okBtn, true);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    styleButton(cancelBtn, false);
    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(buttons);

    const collect = (): AttrDialogResult => {
      const rows: AttrRowEdit[] = new Array(attributes.length);
      const added: ObjAttribute[] = [];
      for (const ctl of rowCtl) {
        const a = ctl.row.attr;
        const edit: AttrRowEdit = {
          name: ctl.name ? ctl.name.value.trim() : undefined,
          value: ctl.value ? ctl.value.value : a.value,
          visibility: ctl.visibility ? Number(ctl.visibility.value) : a.visibility,
          type: ctl.type ? typeFromDisplay(ctl.type.value.trim()) : a.type,
          comment: ctl.comment ? ctl.comment.value : a.comment,
          color: ctl.color ? hexToColorInt(ctl.color.value) : a.color,
          useratts: ctl.useratts ? ctl.useratts.value : a.useratts,
          resetval: ctl.resetval ? ctl.resetval.value : a.resetval,
        };
        if (ctl.row.origIndex !== null) {
          rows[ctl.row.origIndex] = edit;
        } else {
          // A freshly added local attribute: build it from the row's inputs.
          const na = newLocalAttribute((ctl.name && ctl.name.value.trim()) || a.name);
          na.value = edit.value;
          na.visibility = edit.visibility;
          na.type = edit.type;
          na.comment = edit.comment;
          na.color = edit.color;
          na.useratts = edit.useratts;
          na.resetval = edit.resetval;
          added.push(na);
        }
      }
      const extras: FormResult = {};
      for (const field of extraFields) {
        const el = extraInputs.get(field.key)!;
        extras[field.key] = field.kind === 'checkbox' ? (el as HTMLInputElement).checked : (el as HTMLInputElement | HTMLSelectElement).value;
      }
      return { rows, extras, added, removedNames: [...removedNames] };
    };

    const cleanup = (result: AttrDialogResult | null) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      }
    };
    okBtn.addEventListener('click', () => cleanup(collect()));
    cancelBtn.addEventListener('click', () => cleanup(null));
    document.addEventListener('keydown', onKey, true);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}
