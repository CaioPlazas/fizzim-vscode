import * as vscode from 'vscode';
import * as path from 'path';
import { runCodegen } from './codegen';
import { defaultDocument } from './fzm/model';
import { serializeFzm } from './fzm/serializer';

class FizzimEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'fizzim.editor';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    const cfg = vscode.workspace.getConfiguration('fizzim');
    const darkMode = cfg.get<boolean>('darkMode', false);
    const defaults = {
      stateColor: cfg.get<string>('defaultStateColor', '#000000'),
      transitionColor: cfg.get<string>('defaultTransitionColor', '#000000'),
      loopbackColor: cfg.get<string>('defaultLoopbackColor', '#000000'),
    };
    webviewPanel.webview.html = getHtml(webviewPanel.webview, this.extensionUri, document.getText(), darkMode, defaults);

    // Text we last wrote to the document ourselves (from a webview edit), so we
    // can tell our own edits apart from external ones and avoid reloading the
    // webview - which would wipe selection/interaction state mid-edit.
    let lastSyncedText = document.getText();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.document.getText() === lastSyncedText) return; // our own edit, already reflected
      lastSyncedText = e.document.getText();
      webviewPanel.webview.postMessage({ type: 'externalUpdate', text: lastSyncedText });
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'edit') {
        lastSyncedText = msg.text;
        await updateTextDocument(document, msg.text);
      } else if (msg.type === 'generate') {
        await generateHdl(document, msg.text, this.extensionUri, msg.language, msg.customArgs);
      } else if (msg.type === 'viewAsText') {
        // Swaps this tab from the diagram editor to VS Code's plain text editor
        // on the same underlying document (same URI, same view column), so the
        // user can view/edit the raw .fzm tags by hand. To get back to the
        // diagram, reopen the file (right-click the tab -> Reopen Editor With
        // -> Fizzim Diagram), same as any other "open with" swap.
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', webviewPanel.viewColumn);
      } else if (msg.type === 'exportImage') {
        await exportImage(document, msg.dataUrl);
      } else if (msg.type === 'undo') {
        await vscode.commands.executeCommand('undo');
      } else if (msg.type === 'redo') {
        await vscode.commands.executeCommand('redo');
      } else if (msg.type === 'setDarkMode') {
        await vscode.workspace
          .getConfiguration('fizzim')
          .update('darkMode', Boolean(msg.value), vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'command' && typeof msg.command === 'string') {
        // Menu-bar items that map to VS Code commands (New/Open/Save/Save As).
        await vscode.commands.executeCommand(msg.command);
      } else if (msg.type === 'setDefaultColors') {
        const c = vscode.workspace.getConfiguration('fizzim');
        const target = vscode.ConfigurationTarget.Global;
        await c.update('defaultStateColor', String(msg.stateColor), target);
        await c.update('defaultTransitionColor', String(msg.transitionColor), target);
        await c.update('defaultLoopbackColor', String(msg.loopbackColor), target);
      }
    });
  }
}

function updateTextDocument(document: vscode.TextDocument, text: string): Thenable<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  return vscode.workspace.applyEdit(edit);
}

// Writes an image data URL (from the webview's canvas.toDataURL) to a file.
async function exportImage(document: vscode.TextDocument, dataUrl: string): Promise<void> {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    vscode.window.showErrorMessage('Export failed: unexpected image data.');
    return;
  }
  const isJpeg = match[1] === 'jpeg';
  const ext = isJpeg ? 'jpg' : 'png';
  const base = document.uri.path.replace(/\.fzm$/i, '');
  const target = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({ path: `${base}.${ext}` }),
    filters: isJpeg ? { 'JPEG image': ['jpg', 'jpeg'] } : { 'PNG image': ['png'] },
    title: `Export diagram as ${ext.toUpperCase()}`,
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(match[2], 'base64'));
  vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}`);
}

async function generateHdl(document: vscode.TextDocument, fzmText: string, extensionUri: vscode.Uri, languageOverride?: string, customArgs?: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('fizzim');
  const perlPath = config.get<string>('perlPath', 'perl');
  // The generator (fizzim.pl) ships inside the extension so "Generate HDL" works
  // out of the box; fizzim.scriptPath is an optional override for a custom one.
  const configuredScript = config.get<string>('scriptPath', '').trim();
  const scriptPath = configuredScript || vscode.Uri.joinPath(extensionUri, 'resources', 'fizzim.pl').fsPath;
  const language = languageOverride || config.get<string>('language', 'verilog');

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Generating HDL…' },
    () => runCodegen(perlPath, scriptPath, language, fzmText, customArgs)
  );

  if (!result.ok) {
    const detail = result.error ?? result.stderr ?? 'unknown error';
    vscode.window.showErrorMessage(`Code generation failed: ${detail.split('\n')[0]}`);
    return;
  }

  const ext = language === 'vhdl' ? 'vhd' : 'v';
  const base = document.uri.path.replace(/\.fzm$/i, '');
  const defaultUri = document.uri.with({ path: `${base}.${ext}` });
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: language === 'vhdl' ? { VHDL: ['vhd', 'vhdl'] } : { Verilog: ['v', 'sv'] },
    title: 'Save generated HDL',
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, Buffer.from(result.stdout, 'utf8'));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
  vscode.window.showInformationMessage(`Generated ${path.basename(target.fsPath)}`);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  text: string,
  darkMode: boolean,
  defaults: { stateColor: string; transitionColor: string; loopbackColor: string }
): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));

  return /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    html, body { height: 100%; }
    body {
      margin: 0; padding: 0;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      display: flex; flex-direction: column;
    }
    /* Menu bar: Fizzim's structure/feel, but themed with VS Code's own menu
       colors so it fits whatever theme the user runs (light or dark). */
    #menubar {
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: stretch;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-foreground, #ccc);
      border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
      font-family: var(--vscode-font-family, sans-serif); font-size: 13px;
      user-select: none;
    }
    .menu { position: relative; }
    .menu-title {
      padding: 4px 11px; cursor: default; border: none; background: transparent;
      color: inherit; font: inherit; height: 100%;
    }
    .menu.open > .menu-title, .menu-title:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }
    .menu-dropdown, .menu-subdropdown {
      display: none; position: absolute; min-width: 210px;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
      color: var(--vscode-menu-foreground, var(--vscode-foreground, #ccc));
      border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, #454545));
      box-shadow: 0 2px 8px rgba(0,0,0,0.36); padding: 4px 0; z-index: 200;
    }
    .menu-dropdown { top: 100%; left: 0; }
    .menu.open > .menu-dropdown { display: block; }
    .menu-item {
      display: block; width: 100%; text-align: left; box-sizing: border-box;
      padding: 4px 26px 4px 20px; cursor: default; border: none; background: transparent;
      color: inherit; font: inherit; white-space: nowrap; position: relative;
    }
    .menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #094771));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #fff));
    }
    .menu-item:disabled { opacity: 0.5; background: transparent; color: inherit; }
    .menu-sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-editorWidget-border, #454545)); margin: 4px 8px; }
    .menu-item.toggle { display: flex; align-items: center; gap: 8px; }
    .menu-item.toggle input { margin: 0; }
    .menu-sub { position: relative; }
    .menu-item.has-sub::after { content: "\\25B8"; position: absolute; right: 9px; opacity: 0.7; }
    .menu-subdropdown { top: -4px; left: 100%; min-width: 160px; }
    .menu-sub:hover > .menu-subdropdown { display: block; }
    #counts { margin-left: auto; align-self: center; padding: 0 12px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
    #canvas-wrap { flex: 1 1 auto; overflow: auto; }
    #page-tabs {
      display: flex; gap: 2px; padding: 4px 8px;
      background: var(--vscode-editorWidget-background, #252526);
      border-top: 1px solid var(--vscode-editorWidget-border, #454545);
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
      flex: 0 0 auto;
    }
    #page-tabs:empty { display: none; }
    #page-tabs .page-tab {
      padding: 3px 12px; cursor: pointer; border: none;
      color: var(--vscode-tab-inactiveForeground, #999);
      background: var(--vscode-tab-inactiveBackground, #2d2d2d);
    }
    #page-tabs .page-tab.active {
      color: var(--vscode-tab-activeForeground, #fff);
      background: var(--vscode-tab-activeBackground, #1e1e1e);
      border-bottom: 2px solid var(--vscode-focusBorder, #0e639c);
    }
  </style>
</head>
<body>
  <div id="menubar">
    <div class="menu" data-menu="file">
      <button class="menu-title">File</button>
      <div class="menu-dropdown">
        <button class="menu-item" id="menu-new">New Diagram</button>
        <button class="menu-item" id="menu-open">Open&hellip;</button>
        <button class="menu-item" id="menu-save">Save</button>
        <button class="menu-item" id="menu-saveas">Save As&hellip;</button>
        <div class="menu-sep"></div>
        <button class="menu-item" id="menu-viewtext">View/Edit as Text&hellip;</button>
        <div class="menu-sep"></div>
        <div class="menu-sub">
          <button class="menu-item has-sub">Export to</button>
          <div class="menu-subdropdown">
            <button class="menu-item" id="export-png-btn">PNG&hellip;</button>
            <button class="menu-item" id="export-jpg-btn">JPEG&hellip;</button>
          </div>
        </div>
        <div class="menu-sub">
          <button class="menu-item has-sub">Generate HDL</button>
          <div class="menu-subdropdown">
            <button class="menu-item" data-lang="verilog">Verilog</button>
            <button class="menu-item" data-lang="vhdl">VHDL</button>
            <button class="menu-item" data-lang="systemverilog">SystemVerilog</button>
          </div>
        </div>
        <div class="menu-sep"></div>
        <button class="menu-item" id="prefs-btn">Preferences&hellip;</button>
        <button class="menu-item" id="menu-pagesetup">Page Setup&hellip;</button>
      </div>
    </div>
    <div class="menu" data-menu="edit">
      <button class="menu-title">Edit</button>
      <div class="menu-dropdown">
        <button class="menu-item" id="menu-undo">Undo</button>
        <button class="menu-item" id="menu-redo">Redo</button>
        <div class="menu-sep"></div>
        <button class="menu-item" id="menu-delete">Delete</button>
      </div>
    </div>
    <div class="menu" data-menu="global">
      <button class="menu-title">Global Attributes</button>
      <div class="menu-dropdown">
        <button class="menu-item" data-tab="0">State Machine&hellip;</button>
        <button class="menu-item" data-tab="1">Inputs&hellip;</button>
        <button class="menu-item" data-tab="2">Outputs&hellip;</button>
        <button class="menu-item" data-tab="3">States&hellip;</button>
        <button class="menu-item" data-tab="4">Transitions&hellip;</button>
      </div>
    </div>
    <div class="menu" data-menu="view">
      <button class="menu-title">View</button>
      <div class="menu-dropdown">
        <button class="menu-item" id="zoom-in-btn">Zoom In</button>
        <button class="menu-item" id="zoom-out-btn">Zoom Out</button>
        <button class="menu-item" id="zoom-reset-btn">Reset Zoom (100%)</button>
        <button class="menu-item" id="zoom-fit-btn">Fit to Window</button>
        <button class="menu-item" id="fit-page-btn">Fit Page</button>
        <div class="menu-sep"></div>
        <label class="menu-item toggle"><input type="checkbox" id="grid-toggle"> Grid</label>
        <label class="menu-item toggle"><input type="checkbox" id="table-toggle"> Global Table</label>
        <label class="menu-item toggle"><input type="checkbox" id="dark-toggle"> Dark Mode</label>
      </div>
    </div>
    <div class="menu" data-menu="help">
      <button class="menu-title">Help</button>
      <div class="menu-dropdown">
        <button class="menu-item" id="menu-about">About Fizzim for VS Code</button>
      </div>
    </div>
    <span id="counts"></span>
  </div>
  <div id="canvas-wrap"><canvas id="canvas"></canvas></div>
  <div id="page-tabs"></div>
  <script nonce="${nonce}">window.__FZM_TEXT__ = ${JSON.stringify(text)}; window.__FZM_DARK__ = ${darkMode ? 'true' : 'false'}; window.__FZM_DEFAULTS__ = ${JSON.stringify(defaults)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      FizzimEditorProvider.viewType,
      new FizzimEditorProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('fizzim.newDiagram', async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { 'Fizzim FSM': ['fzm'] },
        saveLabel: 'Create',
        title: 'New Fizzim diagram',
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(serializeFzm(defaultDocument()), 'utf8'));
      await vscode.commands.executeCommand('vscode.openWith', target, FizzimEditorProvider.viewType);
    })
  );
}

export function deactivate(): void {}
