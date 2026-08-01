# Changelog

## 2.0.9 — dragging & moving fixes (pre-release)

Same fix set as stable 1.5.7, plus one that only affects this line.

- **Stub arrows no longer shrink while you drag a state.** The longer the drag,
  the more length they lost — a slow drag across the page could shrink one away
  to nothing. Stubs now keep their exact length and angle however far you move
  the state, matching the original Fizzim.
- **Cross-page connectors no longer collapse against the right page edge.** The
  pentagon "road sign" used to stay welded to the edge while the state kept
  going, squashing the connector flat. It now travels with the state and simply
  runs off the page; **Page Setup** or **Fit to Drawing** docks it back.
- **Moving a multi-selection to another page keeps its transition curves.** Any
  transition between two selected states used to be rebuilt from scratch, and
  its labels were left behind on the old page.
- **Arrow keys work after Ctrl+A.** They nudge the whole selection instead of
  doing nothing.
- **Dragging a group past the top-left corner can't lose states off-canvas**
  any more, where they couldn't be clicked or selected again.
- **The canvas now grows as soon as you drop a dragged object**, instead of
  jumping the next time you zoomed or switched pages.
- **Selection handles grab where they're drawn at any zoom.** Zoomed in they
  drew far larger than their clickable area; zoomed out, too small to hit.
- **No more dead zone around a state's connect anchor** (pre-release only),
  where the cursor said "connect" but pressing dragged the state instead.

## 2.0.8 — cross-page connector geometry-reset fix (pre-release)

- **Fixed: opening a state's Properties dialog and clicking OK without
  changing Width/Height (e.g. after only editing its color or an attribute)
  could still snap a hand-dragged cross-page connector back to its default
  docked position.** Same underlying issue as 2.0.7, in `resizeState`'s
  cross-page branch.
- **Fixed: Page Setup and Fit to Drawing re-docked every cross-page
  connector even when the page size hadn't actually changed**, discarding
  any hand-dragged connector position.

## 2.0.7 — transition Properties dialog geometry-reset fix (pre-release)

- **Fixed: editing any field in a transition's Properties dialog (equation,
  priority, color, name, ...) could reset its geometry** — a stub's
  hand-dragged tip snapped back to its default position, and an ordinary
  transition's hand-shaped curve was recomputed from scratch, even though
  only an unrelated field was changed.

## 2.0.6 — Java-parity audit sweep (pre-release)

Bug fix sweep from a systematic audit against the original Fizzim's Java
source. No change to the `.fzm` format itself, but several of these fix real
data-loss / wrong-HDL bugs. Same fix set as stable 1.5.4 — see its changelog
entry for the full list:

- Mealy outputs surviving a Global Attributes reconcile.
- Fractional coordinates at non-100% zoom no longer reach the `.fzm` file.
- Clearing an output's value or a transition's Priority reverts to the
  declared default instead of blanking/deleting it.
- A newly declared reset state uses a type compatible with one-hot encoding.
- Transition curves survive group drags and slow multi-frame drags.
- Dragging can no longer strand an object permanently off-screen.
- Same-page "stub" transitions and cross-page connectors no longer conflict.
- Cross-page connectors re-dock on page-size changes and re-stagger when a
  sibling connector is added or removed.
- Several Global Attributes dialog validation gaps closed (Type column
  restore-on-empty, output-mirror row locking, duplicate/invalid name
  validation, a rejected rename no longer discarding other pending edits).
- Dragging a stub's anchor or tip now correctly rotates the arrow outward.
- Reconnecting a stub transition re-seeds its geometry on the new state.
- Deleting a page keeps the on-canvas global attributes table on a valid page.

## 2.0.5 — new-object attribute seeding fix (pre-release)

No change to the `.fzm` format or the generated Verilog/VHDL.

- **Fixed: a new state/transition/loopback didn't pick up an already-declared
  Priority, Graycode, custom attribute, or output until Global Attributes was
  reopened.** Drawing a transition after clicking "Add Priority" produced one
  with no priority row at all; the same gap affected a new state missing an
  already-declared output. New objects are now seeded from the current global
  attribute lists immediately, matching the original Fizzim.

## 2.0.4 — transition curve reset fix (pre-release)

No change to the `.fzm` format or the generated Verilog/VHDL.

- **Fixed: a transition's hand-drawn curve could reset to a straight default
  shape just from moving, resizing, or arrow-key-nudging one of its connected
  states.** Ordinary state moves now translate the curve with the state
  instead of fully recomputing it; a full re-route still happens only when
  the two states' relative position changes enough to warrant it (matching
  the original Fizzim's own behavior).
- Fixed: a stub transition dragged to exactly zero length would snap back to
  a default 60px length the next time its state moved.

## 2.0.3 — bug fix, New button, wider fields (pre-release)

No change to the `.fzm` format or the generated Verilog/VHDL (serializer
unchanged; golden 93/93 byte-identical).

- **Fixed: a diagram created by hand (a blank file named `*.fzm`, not via
  File > New / the toolbar's New button) would silently lose every state/
  transition attribute — including state names — the first time Global
  Attributes was used (e.g. to add an output).** A hand-created blank file
  has none of the machine/state/transition attribute headers the real Fizzim
  tool always writes; opening one now seeds the same header New Diagram does.
- Added a **New** button to the toolbar — `fizzim.newDiagram` existed only
  as a Command Palette entry before, with no visible affordance.
- The edit bar, the attribute table dialog, other property dialogs, and the
  Global Attributes table now size their text fields to content instead of
  a fixed width — ordinary state names and equations no longer get clipped.

## 2.0.2 — bug fixes and performance (pre-release)

v2 had forked before a round of v1 bug fixes landed and had picked up a couple
of its own; this backports everything found in an audit pass and adds some
canvas rendering performance work. Still `.fzm`- and HDL-compatible with v1
(serializer unchanged; golden 93/93 byte-identical).

- **Fixed: resizing or moving a state with a loopback attached made the
  loopback grow.** Each move/resize event was re-deriving the loopback's
  control points from the previous, already-rounded points, and the rounding
  bias compounded over a drag into a visibly inflating arm. The loopback now
  translates rigidly with its anchor point instead.
- **Fixed: connecting a transition to a state on another page (via drag-to-connect
  or the edit bar's From/To fields) could draw a broken connector into the
  corner of the canvas**, instead of the pentagon "road sign" docked at the
  page edge.
- **Fixed: a transition's page tracking could go stale** after a move or
  reconnect, throwing off the status bar's counts, the canvas's scrollable
  area, and label visibility.
- **Fixed: a dragged stub tip or cross-page connector handle could end up
  somewhere the canvas couldn't scroll to.**
- **Fixed: the edit bar could show stale values** after editing the same
  object through the full attribute dialog (double-click / "All
  attributes…") — it now refreshes correctly.
- The Global Attributes dialog now cancels on Escape, like every other dialog.
- Arrow-key nudging and mouse-drag redraws are now debounced/batched, and the
  canvas theme is cached instead of recomputed on every redraw — snappier
  dragging, especially on larger diagrams.

## 2.0.1 — canvas interaction (pre-release)

Adds modern canvas interaction on top of 2.0.0. Still `.fzm`- and
HDL-compatible with v1 (serializer unchanged).

- **Pan** the view with a middle-drag or by holding **Space** and dragging.
- **Zoom to the cursor** with Ctrl/Cmd + mouse wheel — the point under the
  mouse stays put.
- **Drag-to-connect**: hover a state to reveal its border anchors, then drag
  from one to another state to create a transition (drop back on itself for a
  loopback). The right-click menu still works as a fallback.
- **Snap to grid** while dragging — states, resizes, group moves, and free text
  all snap when the grid is on.
- The edit bar's expanded (pinned) state now persists across reloads.

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
