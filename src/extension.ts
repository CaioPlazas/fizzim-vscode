import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runCodegen } from './codegen';
import { defaultDocument } from './fzm/model';
import { serializeFzm } from './fzm/serializer';

class FizzimEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'fizzim.editor';

  // The diagram a command should act on. VS Code commands are global, but every
  // canvas command ("zoom in", "toggle grid") means "in the editor I'm looking
  // at" - so the provider tracks which panel is focused and forwards to it.
  private activePanel: vscode.WebviewPanel | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Forwards a command to the focused diagram. No-ops when none is focused. */
  invoke(id: string, arg?: unknown): void {
    this.activePanel?.webview.postMessage({ type: 'invoke', id, arg });
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    const cfg = vscode.workspace.getConfiguration('fizzim');
    const defaults = {
      stateColor: cfg.get<string>('defaultStateColor', '#000000'),
      transitionColor: cfg.get<string>('defaultTransitionColor', '#000000'),
      loopbackColor: cfg.get<string>('defaultLoopbackColor', '#000000'),
    };
    webviewPanel.webview.html = getHtml(
      webviewPanel.webview,
      this.extensionUri,
      document.getText(),
      canvasSurface(cfg),
      defaults,
      cfg.get<boolean>('editBarExpanded', false)
    );

    if (webviewPanel.active) this.activePanel = webviewPanel;
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) this.activePanel = webviewPanel;
      else if (this.activePanel === webviewPanel) this.activePanel = null;
    });
    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) this.activePanel = null;
    });

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
      } else if (msg.type === 'setCanvasSurface') {
        const mode = msg.value === 'theme' ? 'theme' : 'paper';
        await vscode.workspace
          .getConfiguration('fizzim')
          .update('canvasSurface', mode, vscode.ConfigurationTarget.Global);
      } else if (msg.type === 'setEditBarExpanded') {
        await vscode.workspace
          .getConfiguration('fizzim')
          .update('editBarExpanded', Boolean(msg.value), vscode.ConfigurationTarget.Global);
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

// The canvas surface mode (see webview/theme.ts). Defaults to 'paper': white is
// the standard for FSM diagrams and what exports always produce, so following
// the VS Code theme is opt-in.
//
// Migration: fizzim.darkMode is the v1 setting this replaced. Someone who turned
// it on wanted a canvas that matched their dark theme, which is now
// canvasSurface: 'theme' - so honor it, but only while canvasSurface itself is
// untouched, otherwise the deprecated setting would override a live choice.
function canvasSurface(cfg: vscode.WorkspaceConfiguration): 'paper' | 'theme' {
  const info = cfg.inspect<string>('canvasSurface');
  const explicit = info?.globalValue ?? info?.workspaceValue ?? info?.workspaceFolderValue;
  if (explicit === 'paper' || explicit === 'theme') return explicit;
  return cfg.get<boolean>('darkMode', false) ? 'theme' : 'paper';
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
  surface: 'paper' | 'theme',
  defaults: { stateColor: string; transitionColor: string; loopbackColor: string },
  editBarExpanded: boolean
): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editor.css'));
  // VS Code's own icon font, copied into media/codicons by `npm run build:icons`
  // so the toolbar's glyphs are the same ones the rest of the window uses. The
  // buttons carry text labels too, so a missing font costs an icon, not a
  // usable toolbar.
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css'));
  // The body markup lives in media/body.html rather than in this template, so
  // scripts/preview.mjs renders the same chrome the real editor does.
  const body = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'body.html').fsPath, 'utf8');

  return /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
${body}
  <script nonce="${nonce}">window.__FZM_TEXT__ = ${JSON.stringify(text)}; window.__FZM_SURFACE__ = ${JSON.stringify(surface)}; window.__FZM_DEFAULTS__ = ${JSON.stringify(defaults)}; window.__FZM_EDITBAR_EXPANDED__ = ${editBarExpanded ? 'true' : 'false'};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// The five tabs of the Global Attributes editor, in the order the webview's
// globalEditor.ts expects them.
const GLOBAL_TABS = ['State Machine', 'Inputs', 'Outputs', 'States', 'Transitions'];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FizzimEditorProvider(context.extensionUri);

  // Every one of these was a menu-bar item in v1. As commands they're in the
  // Command Palette for free, they're keybindable by the user, and the ones
  // worth one click are in the editor title bar (see package.json).
  const forward = (command: string, id: string) =>
    vscode.commands.registerCommand(command, () => provider.invoke(id));

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      FizzimEditorProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    forward('fizzim.zoomIn', 'zoomIn'),
    forward('fizzim.zoomOut', 'zoomOut'),
    forward('fizzim.zoomReset', 'zoomReset'),
    forward('fizzim.zoomFit', 'zoomFit'),
    forward('fizzim.fitPage', 'fitPage'),
    forward('fizzim.toggleGrid', 'toggleGrid'),
    forward('fizzim.toggleTable', 'toggleTable'),
    forward('fizzim.toggleCanvasSurface', 'toggleSurface'),
    forward('fizzim.preferences', 'preferences'),
    forward('fizzim.pageSetup', 'pageSetup'),
    forward('fizzim.viewAsText', 'viewAsText'),
    forward('fizzim.about', 'about'),

    // The language submenu becomes a QuickPick, defaulting to the configured
    // language so the common case is Enter.
    vscode.commands.registerCommand('fizzim.generateHdl', async () => {
      const configured = vscode.workspace.getConfiguration('fizzim').get<string>('language', 'verilog');
      const items = [
        { label: 'Verilog', id: 'verilog' },
        { label: 'VHDL', id: 'vhdl' },
        { label: 'SystemVerilog', id: 'systemverilog' },
      ].sort((a, b) => (a.id === configured ? -1 : b.id === configured ? 1 : 0));
      const pick = await vscode.window.showQuickPick(items, { title: 'Generate HDL', placeHolder: 'Target language' });
      if (pick) provider.invoke('generate', pick.id);
    }),

    vscode.commands.registerCommand('fizzim.exportImage', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'PNG', description: 'lossless — the usual choice', id: 'image/png' },
          { label: 'JPEG', id: 'image/jpeg' },
        ],
        { title: 'Export diagram as image', placeHolder: 'Format' }
      );
      if (pick) provider.invoke('export', pick.id);
    }),

    vscode.commands.registerCommand('fizzim.globalAttributes', async () => {
      const pick = await vscode.window.showQuickPick(
        GLOBAL_TABS.map((label, index) => ({ label, index })),
        { title: 'Global Attributes', placeHolder: 'Which tab?' }
      );
      if (pick) provider.invoke('globals', pick.index);
    }),

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
