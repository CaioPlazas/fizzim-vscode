# Changelog

## 2.0.0 — visual & UX modernization (pre-release)

First pre-release of the v2 line — a ground-up modernization of the look and
interaction, in active development on the pre-release channel. **The `.fzm`
format and the generated Verilog/VHDL are unchanged** (verified byte-identical
against the reference corpus), so files and HDL stay fully compatible with v1
and the original Fizzim.

- **Crisp canvas.** Fixed a `devicePixelRatio` bug that made every stroke soft on
  HiDPI/scaled displays — states, arrows, and labels are now sharp.
- **Modern shape language.** Filled state shapes, real UI typography (bold state
  names, muted outputs), tapered arrowheads, a dot grid, and hover feedback with
  proper cursors. Selection uses the theme's accent with a soft halo instead of a
  red box.
- **Canvas surface.** White "paper" by default (the standard for FSM diagrams);
  an opt-in toggle follows the VS Code theme. Image exports are **always** white,
  whichever mode you work in.
- **Native VS Code chrome.** The in-editor menu bar is gone: actions are a slim
  canvas toolbar plus `Fizzim:` Command Palette commands, with a status bar
  showing the selection, counts, cursor position, and a zoom control. Page tabs
  restyled to match VS Code.
- **New editing model.** An always-present **edit bar** below the toolbar edits
  the selected object's common fields live (name, reset, colour, outputs /
  equation, priority, from-to, stub). For states with many outputs it pages with
  `‹`/`›` arrows or expands vertically (pinnable). Double-click or **Enter** opens
  the full property dialog for the long tail.
- **Safer deletes.** Deleting shows a status-bar hint that Ctrl+Z restores it.

## 1.3.1

- Generate HDL output is now deterministic (Perl hash-seed pinned in the
  bundled `fizzim.pl` invocation).

## 1.3.0 — parity-fix round 2

- Page delete (cleans up dangling transitions, renumbers pages, confirms).
- Preferences: default state width/height.
- Free text renders literal `\n` as stacked lines.
- Rename LOCAL attributes from the property dialog.
- Inputs tab locks Visibility/Color where the original does.
- Selection now draws a red box around a selected object's labels (equation/
  priority included), including while dragging.
- Export renders offscreen at 100% zoom on a white background.
- Group "Move to Page" from an empty-canvas right click.
- Real cross-page connectors: bezier curve + pentagon "road sign" + four
  draggable handles per page, sibling stagger, re-docking on state move/
  resize, accurate hit-testing.
- Preferences font pickers are now dropdowns.

## 1.2.0 — Java-vs-VS Code parity audit fixes

- Editing a Global Attribute's default now propagates to every non-overridden
  state/transition (previously only add/delete/rename propagated).
- Global Attributes validation: only reg/regdp may carry a reset value; flags
  can't have a default; "Add User Attribute" available on every tab.
- Cross-page transition labels no longer duplicate on both endpoint pages;
  right-click a label to move it to its endpoint page.
- Loopback dialog gains a "State:" dropdown to re-attach a loopback.
- Free text gains "Move to Page" and moves with group page-moves.
- Empty-canvas menu gains "New State Transition" / "New Loopback Transition";
  every object's right-click menu gains "Edit … Properties" / "Edit Text".
- Page rename rejects empty/duplicate names.

## 1.1.0

- Custom `fizzim.pl` arguments (per-file, editable in Preferences) — reaches
  flags with no `.fzm` representation, e.g. `-encoding onehot`.
- Global Attributes tabs show the full 8-column table (Comment/Color/
  UserAtts/ResetValue alongside Name/Value/Type/Visibility).
- File → "View/Edit as Text…" swaps the current tab to VS Code's plain text
  editor on the same document.

## 1.0.0 — feature parity + Fizzim-style menu bar

- Replaced the flat toolbar with a dropdown menu bar mirroring Fizzim's menus
  (File / Edit / Global Attributes / View / Help).
- Whole-UI feel now matches the original Fizzim desktop app end-to-end, with
  a modern VS Code look (menu bar and page tabs are theme-aware).

## 0.2.1

- "New State" opens the State Properties dialog to customize the new state;
  "Quick New State" is the old instant-drop.
- Same-page transition stub tip is an open "V" chevron, matching the
  original.

## 0.2.0

- Movable attribute text (name/outputs/equation/priority).
- Priority + Graycode encoding on transitions.
- New/Delete per-object attribute.
- Dark-mode canvas toggle, default state/transition/loopback colors.
- Bundled `fizzim.pl` — HDL generation works out of the box.

## 0.1.x

Initial development: `.fzm` parsing/serialization, canvas rendering, basic
create/select/drag/delete, and the first working HDL-generation pipeline.
