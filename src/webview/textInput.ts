// window.prompt/alert/confirm are all no-ops inside a VS Code webview iframe,
// so we can't use them. This is a small promise-based replacement that mirrors
// Java's JOptionPane.showInputDialog: a modal box with a text field, OK/Cancel,
// Enter to submit, Escape to cancel. Resolves to the entered string, or null
// if cancelled.
export function promptText(message: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.background = 'rgba(0,0,0,0.4)';
    backdrop.style.display = 'flex';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';
    backdrop.style.zIndex = '2000';

    const box = document.createElement('div');
    box.style.background = 'var(--vscode-editorWidget-background, #252526)';
    box.style.color = 'var(--vscode-editorWidget-foreground, #cccccc)';
    box.style.border = '1px solid var(--vscode-editorWidget-border, #454545)';
    box.style.padding = '16px';
    box.style.minWidth = '280px';
    box.style.fontFamily = 'var(--vscode-font-family, sans-serif)';
    box.style.fontSize = '13px';
    box.style.boxShadow = '0 2px 12px rgba(0,0,0,0.4)';

    const label = document.createElement('div');
    label.textContent = message;
    label.style.marginBottom = '8px';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initial;
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '4px 6px';
    input.style.background = 'var(--vscode-input-background, #3c3c3c)';
    input.style.color = 'var(--vscode-input-foreground, #cccccc)';
    input.style.border = '1px solid var(--vscode-input-border, #3c3c3c)';
    input.style.outline = 'none';

    const buttons = document.createElement('div');
    buttons.style.marginTop = '12px';
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.gap = '8px';

    const makeButton = (text: string, primary: boolean): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.style.padding = '4px 12px';
      btn.style.cursor = 'pointer';
      btn.style.border = 'none';
      btn.style.color = primary
        ? 'var(--vscode-button-foreground, #ffffff)'
        : 'var(--vscode-button-secondaryForeground, #cccccc)';
      btn.style.background = primary
        ? 'var(--vscode-button-background, #0e639c)'
        : 'var(--vscode-button-secondaryBackground, #3a3d41)';
      return btn;
    };

    const okBtn = makeButton('OK', true);
    const cancelBtn = makeButton('Cancel', false);

    const cleanup = (result: string | null) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };

    const submit = () => cleanup(input.value.length > 0 ? input.value : null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      }
    };

    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => cleanup(null));
    document.addEventListener('keydown', onKey, true);

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(buttons);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}
