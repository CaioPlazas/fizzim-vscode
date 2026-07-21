// A small promise-based modal form, generalizing textInput.ts. Native dialogs
// (prompt/alert/confirm) are no-ops in a VS Code webview, so property editing
// (mirroring Java's StateProperties/TransProperties) is built from DOM.

export type Field =
  | { kind: 'text'; key: string; label: string; value: string }
  | { kind: 'checkbox'; key: string; label: string; value: boolean }
  | { kind: 'select'; key: string; label: string; value: string; options: string[] }
  | { kind: 'color'; key: string; label: string; value: string };

export type FormResult = Record<string, string | boolean>;

function styleButton(btn: HTMLButtonElement, primary: boolean): void {
  btn.style.padding = '4px 12px';
  btn.style.cursor = 'pointer';
  btn.style.border = 'none';
  btn.style.color = primary ? 'var(--vscode-button-foreground, #fff)' : 'var(--vscode-button-secondaryForeground, #ccc)';
  btn.style.background = primary ? 'var(--vscode-button-background, #0e639c)' : 'var(--vscode-button-secondaryBackground, #3a3d41)';
}

function makeBackdrop(): HTMLDivElement {
  const backdrop = document.createElement('div');
  backdrop.style.position = 'fixed';
  backdrop.style.inset = '0';
  backdrop.style.background = 'rgba(0,0,0,0.4)';
  backdrop.style.display = 'flex';
  backdrop.style.alignItems = 'center';
  backdrop.style.justifyContent = 'center';
  backdrop.style.zIndex = '2000';
  return backdrop;
}

function makeBox(): HTMLDivElement {
  const box = document.createElement('div');
  box.style.background = 'var(--vscode-editorWidget-background, #252526)';
  box.style.color = 'var(--vscode-editorWidget-foreground, #ccc)';
  box.style.border = '1px solid var(--vscode-editorWidget-border, #454545)';
  box.style.padding = '16px';
  box.style.minWidth = '340px';
  // A safety cap, not the normal case: text fields below size to their own
  // content (see sizeToContent), so the box's shrink-to-fit width already
  // grows with them. This only kicks in for a genuinely huge value, trading a
  // scrollbar for never cutting text off outright.
  box.style.maxWidth = '90vw';
  box.style.maxHeight = '88vh';
  box.style.overflow = 'auto';
  box.style.fontFamily = 'var(--vscode-font-family, sans-serif)';
  box.style.fontSize = '13px';
  box.style.boxShadow = '0 2px 12px rgba(0,0,0,0.4)';
  return box;
}

// Sizes a text field to its content instead of stretching to 100% of the
// dialog box (which, for a single-field dialog, meant the box collapsed to
// its minWidth and the field was only ever as wide as that floor - the
// original cause of clipped state/page names in "rename" style dialogs).
// Grows on every keystroke; caps at maxCh so the box's maxWidth/overflow
// safety net (above) is what handles a truly huge value, not an ever-growing
// input.
function sizeToContent(inp: HTMLInputElement, minCh: number, maxCh: number): void {
  const size = () => { inp.style.width = `${Math.min(maxCh, Math.max(minCh, inp.value.length + 1))}ch`; };
  size();
  inp.addEventListener('input', size);
}

export function showForm(title: string, fields: Field[]): Promise<FormResult | null> {
  return new Promise((resolve) => {
    const backdrop = makeBackdrop();
    const box = makeBox();

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.fontWeight = 'bold';
    heading.style.marginBottom = '12px';
    box.appendChild(heading);

    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    let firstInput: HTMLElement | null = null;

    for (const field of fields) {
      const row = document.createElement('div');
      row.style.marginBottom = '10px';

      if (field.kind === 'checkbox') {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '6px';
        label.style.cursor = 'pointer';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = field.value;
        label.appendChild(input);
        label.appendChild(document.createTextNode(field.label));
        row.appendChild(label);
        inputs.set(field.key, input);
      } else {
        const label = document.createElement('div');
        label.textContent = field.label;
        label.style.marginBottom = '4px';
        row.appendChild(label);

        if (field.kind === 'select') {
          const select = document.createElement('select');
          // No fixed width: a <select> already sizes to its longest option, so
          // constraining it to the (possibly still-collapsed) box width was the
          // one thing here that could clip an option's text rather than the
          // other way around.
          select.style.minWidth = '22ch';
          select.style.padding = '4px';
          select.style.background = 'var(--vscode-input-background, #3c3c3c)';
          select.style.color = 'var(--vscode-input-foreground, #ccc)';
          select.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
          for (const opt of field.options) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (opt === field.value) o.selected = true;
            select.appendChild(o);
          }
          row.appendChild(select);
          inputs.set(field.key, select);
          if (!firstInput) firstInput = select;
        } else if (field.kind === 'color') {
          const colorRow = document.createElement('div');
          colorRow.style.display = 'flex';
          colorRow.style.alignItems = 'center';
          colorRow.style.gap = '8px';
          const colorInput = document.createElement('input');
          colorInput.type = 'color';
          colorInput.value = field.value;
          colorInput.style.width = '32px';
          colorInput.style.height = '28px';
          colorInput.style.padding = '0';
          colorInput.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
          colorInput.style.cursor = 'pointer';
          colorInput.style.background = 'var(--vscode-input-background, #3c3c3c)';
          colorRow.appendChild(colorInput);
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.value = field.value;
          textInput.style.flex = '1';
          textInput.style.padding = '4px 6px';
          textInput.style.background = 'var(--vscode-input-background, #3c3c3c)';
          textInput.style.color = 'var(--vscode-input-foreground, #ccc)';
          textInput.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
          textInput.style.outline = 'none';
          colorRow.appendChild(textInput);
          colorInput.addEventListener('input', () => { textInput.value = colorInput.value; });
          textInput.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) colorInput.value = textInput.value; });
          const resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.textContent = 'Black';
          resetBtn.style.cssText = 'padding:2px 8px;cursor:pointer;border:none;color:var(--vscode-button-secondaryForeground,#ccc);background:var(--vscode-button-secondaryBackground,#3a3d41);';
          resetBtn.addEventListener('click', () => { colorInput.value = '#000000'; textInput.value = '#000000'; });
          colorRow.appendChild(resetBtn);
          row.appendChild(colorRow);
          inputs.set(field.key, textInput);
          if (!firstInput) firstInput = textInput;
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.value = field.value;
          input.style.padding = '4px 6px';
          input.style.background = 'var(--vscode-input-background, #3c3c3c)';
          input.style.color = 'var(--vscode-input-foreground, #ccc)';
          input.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
          input.style.outline = 'none';
          sizeToContent(input, 22, 64);
          row.appendChild(input);
          inputs.set(field.key, input);
          if (!firstInput) firstInput = input;
        }
      }
      box.appendChild(row);
    }

    const buttons = document.createElement('div');
    buttons.style.marginTop = '4px';
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.gap = '8px';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    styleButton(okBtn, true);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    styleButton(cancelBtn, false);
    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(buttons);

    const cleanup = (result: FormResult | null) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const collect = (): FormResult => {
      const out: FormResult = {};
      for (const field of fields) {
        const el = inputs.get(field.key)!;
        out[field.key] = field.kind === 'checkbox' ? (el as HTMLInputElement).checked : (el as HTMLInputElement | HTMLSelectElement).value;
      }
      return out;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(collect());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      }
    };

    okBtn.addEventListener('click', () => cleanup(collect()));
    cancelBtn.addEventListener('click', () => cleanup(null));
    document.addEventListener('keydown', onKey, true);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    if (firstInput) {
      firstInput.focus();
      if (firstInput instanceof HTMLInputElement) firstInput.select();
    }
  });
}

export function showMessage(message: string): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = makeBackdrop();
    const box = makeBox();
    const text = document.createElement('div');
    text.textContent = message;
    text.style.marginBottom = '12px';
    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'flex-end';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    styleButton(okBtn, true);
    buttons.appendChild(okBtn);
    box.appendChild(text);
    box.appendChild(buttons);

    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    };
    okBtn.addEventListener('click', cleanup);
    document.addEventListener('keydown', onKey, true);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}

export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = makeBackdrop();
    const box = makeBox();
    const text = document.createElement('div');
    text.textContent = message;
    text.style.marginBottom = '12px';
    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.gap = '8px';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    styleButton(okBtn, true);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    styleButton(cancelBtn, false);
    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(text);
    box.appendChild(buttons);

    const cleanup = (result: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      }
    };
    okBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    document.addEventListener('keydown', onKey, true);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}
