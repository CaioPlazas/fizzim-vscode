import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { makeTheme, ThemeVars, withAlpha } from './theme';

const DARK: ThemeVars = {
  editorBackground: '#1f1f1f',
  editorForeground: '#cccccc',
  focusBorder: '#0078d4',
  descriptionForeground: '#9d9d9d',
};

test('paper mode is white/black regardless of the VS Code theme', () => {
  const t = makeTheme('paper', DARK);
  assert.equal(t.surface, '#ffffff');
  assert.equal(t.ink, '#000000');
});

test('theme mode follows the VS Code theme colors', () => {
  const t = makeTheme('theme', DARK);
  assert.equal(t.surface, '#1f1f1f');
  assert.equal(t.ink, '#cccccc');
  assert.equal(t.muted, '#9d9d9d');
});

test('export mode is always paper, even under a dark theme', () => {
  // The whole point: a dark session must not ship a dark PNG to a coworker.
  const t = makeTheme('export', DARK);
  assert.equal(t.surface, '#ffffff');
  assert.equal(t.ink, '#000000');
});

test('theme mode falls back to VS Code dark defaults when a variable is missing', () => {
  const t = makeTheme('theme', {});
  assert.equal(t.surface, '#1e1e1e');
  assert.equal(t.ink, '#d4d4d4');
  assert.equal(t.accent, '#0e639c');
});

test('muted falls back to ink when the theme has no descriptionForeground', () => {
  const t = makeTheme('theme', { editorForeground: '#abcdef' });
  assert.equal(t.muted, '#abcdef');
});

test('accent comes from focusBorder in every mode', () => {
  assert.equal(makeTheme('paper', DARK).accent, '#0078d4');
  assert.equal(makeTheme('theme', DARK).accent, '#0078d4');
  assert.equal(makeTheme('export', DARK).accent, '#0078d4');
});

test('state fill derives from ink, never the accent, so exports do not print blue', () => {
  const paper = makeTheme('export', DARK);
  assert.equal(paper.stateFill, 'rgba(0, 0, 0, 0.04)');
  const dark = makeTheme('theme', DARK);
  assert.equal(dark.stateFill, 'rgba(204, 204, 204, 0.04)');
});

test('the label plate is opaque, so it can hide the curve running under a label', () => {
  assert.equal(makeTheme('paper', DARK).plate, '#ffffff');
  assert.equal(makeTheme('theme', DARK).plate, '#1f1f1f');
});

test('grid dots are ink at low alpha, so they read on paper and on any theme', () => {
  assert.equal(makeTheme('paper', DARK).grid, 'rgba(0, 0, 0, 0.22)');
  assert.equal(makeTheme('theme', DARK).grid, 'rgba(204, 204, 204, 0.22)');
});

test('withAlpha expands both hex forms and passes non-hex through', () => {
  assert.equal(withAlpha('#0078d4', 0.12), 'rgba(0, 120, 212, 0.12)');
  assert.equal(withAlpha('#fff', 0.5), 'rgba(255, 255, 255, 0.5)');
  assert.equal(withAlpha('rgba(1, 2, 3, 0.4)', 0.5), 'rgba(1, 2, 3, 0.4)');
});
