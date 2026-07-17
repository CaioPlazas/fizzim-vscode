import { FzmDocument, ObjAttribute } from '../fzm/model';
import {
  addGraycode,
  addInput,
  addOutput,
  addPriority,
  hasTransAttr,
  addReset,
  addUserAttribute,
  deleteGlobalAttr,
  globalList,
  hasReset,
  INPUTS,
  isProtected,
  MACHINE,
  OUTPUTS,
  OutputType,
  reconcileGlobals,
  renameGlobalAttr,
  setGlobalAttrField,
  STATE_ATTRS,
  TRANS_ATTRS,
  validateOutputEdit,
} from './globals';
import { showMessage } from './formDialog';
import { colorIntToHex } from './edit';

const TABS = [
  { index: MACHINE, label: 'Machine' },
  { index: INPUTS, label: 'Inputs' },
  { index: OUTPUTS, label: 'Outputs' },
  { index: STATE_ATTRS, label: 'States' },
  { index: TRANS_ATTRS, label: 'Transitions' },
];

const VIS_OPTIONS = [
  { value: '0', label: 'No' },
  { value: '1', label: 'Yes' },
  { value: '2', label: 'Only non-default' },
];
const OUTPUT_TYPES: OutputType[] = ['comb', 'reg', 'regdp', 'flag'];

// Machine-tab attributes with a fixed set of type values (matching Fizzim).
const MACHINE_TYPE_OPTIONS: Record<string, string[]> = {
  clock: ['posedge', 'negedge'],
  reset_signal: ['posedge', 'negedge', 'positive', 'negative'],
  reset_state: ['allzeros', 'allones', 'anyvalue'],
};

// Edits a deep clone of the document so Cancel is a clean discard. Resolves with
// the edited document on OK, or null on Cancel.
export function showGlobalEditor(doc: FzmDocument, initialTab = MACHINE): Promise<FzmDocument | null> {
  return new Promise((resolve) => {
    const working: FzmDocument = structuredClone(doc);
    let currentTab = initialTab;

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '2000',
    } as CSSStyleDeclaration);

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: 'var(--vscode-editorWidget-background, #252526)',
      color: 'var(--vscode-editorWidget-foreground, #ccc)',
      border: '1px solid var(--vscode-editorWidget-border, #454545)',
      padding: '16px', width: '920px', maxWidth: '95vw', maxHeight: '80vh', overflow: 'auto',
      fontFamily: 'var(--vscode-font-family, sans-serif)', fontSize: '13px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    } as CSSStyleDeclaration);

    const heading = document.createElement('div');
    heading.textContent = 'Global Attributes';
    heading.style.fontWeight = 'bold';
    heading.style.marginBottom = '12px';
    box.appendChild(heading);

    const tabBar = document.createElement('div');
    tabBar.style.display = 'flex';
    tabBar.style.gap = '4px';
    tabBar.style.marginBottom = '10px';
    box.appendChild(tabBar);

    const tableHost = document.createElement('div');
    box.appendChild(tableHost);

    const actionBar = document.createElement('div');
    actionBar.style.display = 'flex';
    actionBar.style.gap = '8px';
    actionBar.style.margin = '10px 0';
    box.appendChild(actionBar);

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '8px';
    box.appendChild(footer);

    const button = (label: string, primary = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        padding: '4px 10px', cursor: 'pointer', border: 'none',
        color: primary ? 'var(--vscode-button-foreground, #fff)' : 'var(--vscode-button-secondaryForeground, #ccc)',
        background: primary ? 'var(--vscode-button-background, #0e639c)' : 'var(--vscode-button-secondaryBackground, #3a3d41)',
      } as CSSStyleDeclaration);
      return b;
    };

    const cleanup = (result: FzmDocument | null) => {
      backdrop.remove();
      resolve(result);
    };

    const cellInput = (value: string, readOnly: boolean, onChange: (v: string) => void): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.readOnly = readOnly;
      Object.assign(input.style, {
        width: '100%', boxSizing: 'border-box', padding: '2px 4px',
        background: readOnly ? 'transparent' : 'var(--vscode-input-background, #3c3c3c)',
        color: 'var(--vscode-input-foreground, #ccc)',
        border: readOnly ? 'none' : '1px solid var(--vscode-input-border, #3c3c3c)',
      } as CSSStyleDeclaration);
      input.addEventListener('change', () => onChange(input.value));
      return input;
    };

    // Color swatch/native picker + a "Black" reset button, matching the
    // per-attribute color cell in the state/transition attribute dialog.
    const cellColor = (value: number, readOnly: boolean, onChange: (hex: string) => void): HTMLElement => {
      const wrap = document.createElement('span');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      if (readOnly) {
        const sw = document.createElement('span');
        Object.assign(sw.style, {
          display: 'inline-block', width: '24px', height: '16px',
          border: '1px solid #000', background: colorIntToHex(value),
        } as CSSStyleDeclaration);
        wrap.appendChild(sw);
        return wrap;
      }
      const input = document.createElement('input');
      input.type = 'color';
      input.value = colorIntToHex(value);
      Object.assign(input.style, {
        width: '28px', height: '22px', padding: '0', cursor: 'pointer', background: 'none',
        border: '1px solid var(--vscode-input-border, #3c3c3c)',
      } as CSSStyleDeclaration);
      input.addEventListener('change', () => onChange(input.value));
      wrap.appendChild(input);
      const resetBtn = button('Black');
      resetBtn.style.marginLeft = '4px';
      resetBtn.addEventListener('click', () => {
        input.value = '#000000';
        onChange('#000000');
      });
      wrap.appendChild(resetBtn);
      return wrap;
    };

    const cellSelect = (value: string, options: { value: string; label: string }[], onChange: (v: string) => void): HTMLSelectElement => {
      const sel = document.createElement('select');
      Object.assign(sel.style, {
        width: '100%', padding: '2px', background: 'var(--vscode-input-background, #3c3c3c)',
        color: 'var(--vscode-input-foreground, #ccc)', border: '1px solid var(--vscode-input-border, #3c3c3c)',
      } as CSSStyleDeclaration);
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };

    const renderTable = () => {
      tableHost.innerHTML = '';
      const list = globalList(working, currentTab);
      const editable =
        currentTab === MACHINE ||
        currentTab === INPUTS ||
        currentTab === OUTPUTS ||
        currentTab === STATE_ATTRS ||
        currentTab === TRANS_ATTRS;
      // Java blocks Visibility and Color on the Inputs tab (Properties.java
      // isCellEditable: global && list == inputs && (col == 2 || col == 5)).
      const lockVisColor = currentTab === INPUTS;

      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      const header = document.createElement('tr');
      for (const h of ['Name', 'Value', 'Type', 'Visibility', 'Comment', 'Color', 'UserAtts', 'ResetValue', '']) {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.textAlign = 'left';
        th.style.padding = '2px 4px';
        th.style.borderBottom = '1px solid var(--vscode-editorWidget-border, #454545)';
        header.appendChild(th);
      }
      table.appendChild(header);

      list.forEach((attr, index) => {
        const row = document.createElement('tr');
        const cell = (child: HTMLElement) => {
          const td = document.createElement('td');
          td.style.padding = '2px 4px';
          td.appendChild(child);
          row.appendChild(td);
        };

        // Outputs shown in the States tab are managed from the Outputs tab.
        const outputMirror = currentTab === STATE_ATTRS && attr.type === 'output';
        const locked = isProtected(attr) || outputMirror;
        const protectedName = locked || !editable;
        cell(
          cellInput(attr.name, protectedName, (v) => {
            const r = renameGlobalAttr(working, currentTab, index, v);
            if (!r.ok) {
              void showMessage(r.error!);
              renderTable();
            }
          })
        );
        // On the Outputs tab, enforce Fizzim's cross-field rules (only regdp/flag
        // can have a reset value; flags can't have a default) — reject + revert.
        const outputCell = (col: number, field: 'value' | 'type' | 'resetval', v: string) => {
          const err = validateOutputEdit(attr, col, v);
          if (err) { void showMessage(err); renderTable(); return; }
          setGlobalAttrField(attr, field, v);
        };

        // reset_state's value is one of the machine's states (Fizzim shows a
        // dropdown); everything else is free text.
        if (currentTab === MACHINE && attr.name === 'reset_state') {
          const stateOpts = ['', ...working.states.map((s) => s.name)].map((n) => ({ value: n, label: n || '(none)' }));
          cell(cellSelect(attr.value, stateOpts, (v) => setGlobalAttrField(attr, 'value', v)));
        } else if (currentTab === OUTPUTS) {
          cell(cellInput(attr.value, !editable, (v) => outputCell(1, 'value', v)));
        } else {
          cell(cellInput(attr.value, !editable, (v) => setGlobalAttrField(attr, 'value', v)));
        }

        const machineTypes = currentTab === MACHINE ? MACHINE_TYPE_OPTIONS[attr.name] : undefined;
        if (currentTab === OUTPUTS) {
          cell(cellSelect(attr.type, OUTPUT_TYPES.map((t) => ({ value: t, label: t })), (v) => outputCell(3, 'type', v)));
        } else if (machineTypes) {
          const opts = machineTypes.includes(attr.type) ? machineTypes : [attr.type, ...machineTypes];
          cell(cellSelect(attr.type, opts.map((t) => ({ value: t, label: t || '(none)' })), (v) => setGlobalAttrField(attr, 'type', v)));
        } else {
          cell(cellInput(attr.type, !editable, (v) => setGlobalAttrField(attr, 'type', v)));
        }
        cell(
          editable && !lockVisColor
            ? cellSelect(String(attr.visibility), VIS_OPTIONS, (v) => setGlobalAttrField(attr, 'visibility', v))
            : cellInput(VIS_OPTIONS[attr.visibility]?.label ?? String(attr.visibility), true, () => {})
        );
        cell(cellInput(attr.comment, !editable, (v) => setGlobalAttrField(attr, 'comment', v)));
        cell(cellColor(attr.color, !editable || lockVisColor, (hex) => setGlobalAttrField(attr, 'color', hex)));
        cell(cellInput(attr.useratts, !editable, (v) => setGlobalAttrField(attr, 'useratts', v)));
        if (currentTab === OUTPUTS) {
          cell(cellInput(attr.resetval, !editable, (v) => outputCell(7, 'resetval', v)));
        } else {
          cell(cellInput(attr.resetval, !editable, (v) => setGlobalAttrField(attr, 'resetval', v)));
        }

        const delCell = document.createElement('td');
        delCell.style.padding = '2px 4px';
        if (editable && !locked) {
          const del = button('✕');
          del.addEventListener('click', () => {
            deleteGlobalAttr(working, currentTab, index);
            renderTable();
          });
          delCell.appendChild(del);
        }
        row.appendChild(delCell);
        table.appendChild(row);
      });

      tableHost.appendChild(table);
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '(none)';
        empty.style.opacity = '0.6';
        empty.style.padding = '6px 4px';
        tableHost.appendChild(empty);
      }
      renderActions();
    };

    const renderActions = () => {
      actionBar.innerHTML = '';
      const add = (label: string, fn: () => void) => {
        const b = button(label);
        b.addEventListener('click', () => {
          fn();
          renderTable();
        });
        actionBar.appendChild(b);
      };
      // A one-per-machine "Add X" button that greys out once X exists (Java
      // disables the button rather than adding a duplicate).
      const addSingleton = (label: string, present: boolean, fn: () => void) => {
        const b = button(label);
        if (present) {
          b.disabled = true;
          b.style.opacity = '0.5';
          b.style.cursor = 'default';
        } else {
          b.addEventListener('click', () => {
            fn();
            renderTable();
          });
        }
        actionBar.appendChild(b);
      };

      if (currentTab === MACHINE) addSingleton('Add Reset', hasReset(working), () => addReset(working));
      if (currentTab === INPUTS) {
        add('Add Input', () => addInput(working, false));
        add('Add Multibit Input', () => addInput(working, true));
      }
      if (currentTab === OUTPUTS) {
        add('Add Output', () => addOutput(working, 'reg', false));
        add('Add Multibit Output', () => addOutput(working, 'reg', true));
        add('Add Flag', () => addOutput(working, 'flag', false));
      }
      // User-defined attributes (Fizzim's "User" button) — on every tab.
      add('Add User Attribute', () => addUserAttribute(working, currentTab));
      // Fizzim's Transitions-tab singletons: Priority (default 1000) and Graycode.
      if (currentTab === TRANS_ATTRS) {
        addSingleton('Add Priority', hasTransAttr(working, 'priority'), () => addPriority(working));
        addSingleton('Add Graycode', hasTransAttr(working, 'graycode'), () => addGraycode(working));
      }
    };

    const renderTabs = () => {
      tabBar.innerHTML = '';
      for (const tab of TABS) {
        const b = button(tab.label, tab.index === currentTab);
        b.addEventListener('click', () => {
          currentTab = tab.index;
          renderTabs();
          renderTable();
        });
        tabBar.appendChild(b);
      }
    };

    const cancelBtn = button('Cancel');
    cancelBtn.addEventListener('click', () => cleanup(null));
    const okBtn = button('OK', true);
    okBtn.addEventListener('click', () => {
      // Re-sync every state/transition against the edited global lists before
      // handing the doc back (Fizzim's updateStates/updateTrans on dialog OK).
      reconcileGlobals(working);
      cleanup(working);
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    renderTabs();
    renderTable();
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}
