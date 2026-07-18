// The canvas palette. Every color the renderer draws with comes from here, so
// restyling the diagram (Phase B) is a change to these token values rather than
// a hunt through render.ts for hard-coded hex.
//
// Three surface modes, because a Fizzim diagram has two audiences:
//  - `paper`  (the default) - white background, black ink, regardless of the VS
//             Code theme. White is the house standard for FSM diagrams and it is
//             what coworkers expect to receive, so it is what we default to.
//  - `theme`  - opt-in (fizzim.canvasSurface), derived from the live VS Code
//             theme so the canvas matches the rest of the window. This is what
//             the old fizzim.darkMode toggle became.
//  - `export` - forced paper. An export must never depend on the mode the author
//             happened to be working in; a dark session still ships a white PNG.
//
// The core (`makeTheme`) is pure and DOM-free so it can be unit-tested; only
// `readThemeVars` touches the document.

export type SurfaceMode = 'paper' | 'theme' | 'export';

export interface Theme {
  mode: SurfaceMode;
  /** Canvas background. */
  surface: string;
  /** Default drawing color: what a black-in-file object (-16777216) resolves to. */
  ink: string;
  /** De-emphasized text (a state's output labels, the global table's cells). */
  muted: string;
  /** Selection / focus. Interactive overlays only — never present in an export. */
  accent: string;
  /** A low-contrast wash of `accent`: hover fills, the marquee interior. */
  accentSoft: string;
  /** The selection halo: `accent` at a glow-ish alpha. */
  accentGlow: string;
  /** Grid dots. */
  grid: string;
  /** Interior of a state ellipse. Exports and prints, so it stays near-neutral. */
  stateFill: string;
  /** Backing plate behind a transition label, so text stays legible over a curve. */
  plate: string;
  /** Interior of a selection/resize handle. */
  handleFill: string;
}

/** The VS Code theme colors we consume, read from the webview's CSS variables. */
export interface ThemeVars {
  editorBackground?: string;
  editorForeground?: string;
  focusBorder?: string;
  descriptionForeground?: string;
}

// Only used when a CSS variable is missing (e.g. the DOM-free unit tests, or a
// theme that doesn't define the token). Mirrors VS Code's own dark defaults.
const FALLBACK_SURFACE = '#1e1e1e';
const FALLBACK_INK = '#d4d4d4';
const FALLBACK_ACCENT = '#0e639c';

const PAPER_SURFACE = '#ffffff';
const PAPER_INK = '#000000';
const PAPER_MUTED = '#555555';

export function makeTheme(mode: SurfaceMode, vars: ThemeVars = {}): Theme {
  // An export is a paper render that can't be talked out of it.
  const paper = mode === 'paper' || mode === 'export';
  const surface = paper ? PAPER_SURFACE : vars.editorBackground || FALLBACK_SURFACE;
  const ink = paper ? PAPER_INK : vars.editorForeground || FALLBACK_INK;
  const accent = vars.focusBorder || FALLBACK_ACCENT;
  return {
    mode,
    surface,
    ink,
    muted: paper ? PAPER_MUTED : vars.descriptionForeground || ink,
    accent,
    accentSoft: withAlpha(accent, 0.1),
    accentGlow: withAlpha(accent, 0.25),
    // Ink at a low alpha rather than a fixed grey, so the dots stay just-visible
    // on white paper and on any theme background.
    grid: withAlpha(ink, 0.22),
    // A whisper of the ink, not a tint of the accent: this one is in the PNG that
    // gets printed and mailed around, so it must not read as "blue" on paper and
    // must not fight the label text sitting on top of it.
    stateFill: withAlpha(ink, 0.04),
    // Opaque, because its whole job is hiding the curve behind a label.
    plate: surface,
    handleFill: surface,
  };
}

// `color` at `alpha`, as an rgba() string. Handles the #rgb / #rrggbb forms VS
// Code themes use; anything else (a named color, an existing rgba()) is passed
// through unchanged rather than guessed at.
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  let h = hex[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/**
 * The live VS Code theme colors. Read fresh on each redraw rather than cached:
 * the user can switch themes with the editor open, and main.ts already watches
 * for that via a MutationObserver on the body class.
 */
export function readThemeVars(): ThemeVars {
  const s = getComputedStyle(document.body);
  const v = (name: string) => s.getPropertyValue(name).trim() || undefined;
  return {
    editorBackground: v('--vscode-editor-background'),
    editorForeground: v('--vscode-editor-foreground'),
    focusBorder: v('--vscode-focusBorder'),
    descriptionForeground: v('--vscode-descriptionForeground'),
  };
}

export function readTheme(mode: SurfaceMode): Theme {
  return makeTheme(mode, readThemeVars());
}
