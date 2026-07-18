// Copies VS Code's icon font out of node_modules and into media/codicons, so
// the packaged VSIX carries it: `vsce package --no-dependencies` doesn't ship
// node_modules, and a webview can only load resources from localResourceRoots.
//
// Runs as part of `npm run build` (and therefore vscode:prepublish), so the
// copy can't go stale or be forgotten before packaging. media/codicons is
// generated and gitignored.
//
// @vscode/codicons is MIT (the font) + CC-BY-4.0 (the icon designs); the
// upstream LICENSE is copied alongside the font to satisfy attribution.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/@vscode/codicons/dist');
const to = resolve(root, 'media/codicons');

if (!existsSync(from)) {
  console.error('@vscode/codicons is not installed — run `npm install` first.');
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) {
  copyFileSync(resolve(from, f), resolve(to, f));
}
// Attribution travels with the font.
const license = resolve(root, 'node_modules/@vscode/codicons/LICENSE');
if (existsSync(license)) copyFileSync(license, resolve(to, 'LICENSE'));

console.log('copied codicons -> media/codicons');
