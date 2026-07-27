# Changelog

## 1.5.4

Bug fix sweep from a systematic audit against the original Fizzim's Java
source. No change to the `.fzm` format itself, but several of these fix real
data-loss / wrong-HDL bugs:

- **Fixed: a Mealy output set on a transition could silently vanish** (and
  its assignment disappear from generated HDL) the next time Global
  Attributes was opened and closed.
- **Fixed: dragging a state at any zoom level other than 100% could write
  fractional coordinates into the `.fzm` file**, which real Fizzim rejects on
  load.
- **Fixed: clearing an output's value on a state, or a transition's Priority,
  used to blank/delete it** instead of reverting to the declared default —
  now matches the original Fizzim, and avoids a "value cannot be determined"
  error on Generate HDL for combinational outputs.
- **Fixed: a newly declared reset state used a type incompatible with
  one-hot encoding**, causing Generate HDL to fail with custom encoding args.
- **Fixed: a hand-shaped transition curve could reset when its states were
  group-dragged together, or slowly dragged across a long distance.**
- **Fixed: dragging an object far past the top-left corner of the canvas
  could strand it permanently off-screen**, unrecoverable except by undo.
- **Fixed: a same-page "stub" transition and a cross-page connector could
  conflict** — toggling Stub off on a cross-page transition left its
  connector collapsed on the state with no way to fix it from the UI.
- **Fixed: cross-page connectors didn't re-dock after a page-size change**,
  and didn't re-stagger when a sibling connector was added or removed.
- **Fixed several Global Attributes dialog gaps**: blanking a Type column,
  editing an output's mirrored row from the States tab, duplicate/invalid
  names going unvalidated, and a rejected rename discarding every other
  pending edit in the dialog.
- **Fixed: dragging a stub's anchor or tip around a state's border didn't
  correctly rotate the arrow outward.**
- **Fixed: reconnecting a stub transition to a new start state left its tip
  pointing at the old one.**
- **Fixed: deleting a page could leave the on-canvas global attributes table
  on an invalid page number.**
- **Fixed: a context menu opened near the bottom or right edge of the canvas
  could run off-screen**, making some items unreachable.

## 1.5.3

Bug fix. No change to the `.fzm` format or the generated Verilog/VHDL.

- **Fixed: a new state/transition/loopback didn't pick up an already-declared
  Priority, Graycode, custom attribute, or output until Global Attributes was
  reopened.** Drawing a transition after clicking "Add Priority" produced one
  with no priority row at all; the same gap affected a new state missing an
  already-declared output. New objects are now seeded from the current global
  attribute lists immediately, matching the original Fizzim.

## 1.5.2

Bug fix. No change to the `.fzm` format or the generated Verilog/VHDL.

- **Fixed: a transition's hand-drawn curve could reset to a straight default
  shape just from moving, resizing, or arrow-key-nudging one of its connected
  states.** Ordinary state moves now translate the curve with the state
  instead of fully recomputing it; a full re-route still happens only when
  the two states' relative position changes enough to warrant it (matching
  the original Fizzim's own behavior).
- Fixed: a stub transition dragged to exactly zero length would snap back to
  a default 60px length the next time its state moved.

## 1.5.1

Bug fix plus a usability pass on dialog/edit-bar field sizing. No change to the
`.fzm` format or the generated Verilog/VHDL (verified byte-identical against
the reference corpus).

- **Fixed: a diagram created by hand (a blank file named `*.fzm`, not via
  File > New) would silently lose every state/transition attribute — including
  state names — the first time Global Attributes was used (e.g. to add an
  output).** A hand-created blank file has none of the machine/state/
  transition attribute headers the real Fizzim tool always writes; opening one
  now seeds the same header File > New does.
- Text fields in the attribute table dialog, other property dialogs, and the
  Global Attributes table now grow to fit their content instead of clipping
  ordinary state names and values inside a fixed-width box.

## 1.5.0

Cross-page transition bug fixes plus interaction polish. No change to the
`.fzm` format or the generated Verilog/VHDL (verified byte-identical against
the reference corpus).

- **Fixed: connecting a transition to a state on another page drew a broken
  connector into the corner of the canvas.** Creating or reconnecting a
  transition between two states that already live on different pages now
  seeds the cross-page connector properly (the pentagon "road sign" docked at
  the page edge), instead of leaving it aimed at the canvas origin.
- **Fixed: a transition's page tracking could go stale** after it moved
  between pages or got reconnected, which could throw off page counts, the
  canvas's scrollable area, and label visibility for a cross-page transition.
- **Fixed: a dragged stub tip or cross-page connector handle could end up
  somewhere the canvas couldn't scroll to.** The canvas bounds now grow to
  include them.
- Ctrl/Cmd + mouse wheel now zooms anchored on the cursor, so the point you're
  pointing at stays put instead of sliding away.
- The Global Attributes dialog now cancels on Escape, like every other dialog.

## 1.4.1

Bug fix and interaction polish. No change to the `.fzm` format or the
generated Verilog/VHDL (verified byte-identical against the reference corpus).

- **Fixed: resizing a state with a loopback attached made the loopback grow.**
  Each resize event was re-deriving the loopback's control points from the
  previous, already-rounded points; the rounding bias compounded over a drag
  into a visibly inflating arm. The loopback now translates rigidly with its
  anchor point instead, so its size stays put no matter how long you drag.
- Snappier drags: redraws are now batched to one per animation frame instead
  of one per mouse-move event.
- Holding an arrow key to nudge a state no longer creates an undo step (and
  round-trips the whole document) on every single pixel of movement.
- The canvas re-crisps automatically if you drag the window to a monitor with
  different display scaling.
- Resize and pointer cursors now show up over drag handles and objects.

## 1.4.0

Two rendering/interaction refinements. No change to the `.fzm` format or the
generated Verilog/VHDL (verified byte-identical against the reference corpus).

- **Crisp on HiDPI displays.** The canvas is now drawn at the display's true
  pixel density, so states, arrows, and labels are sharp on Retina / scaled
  monitors instead of slightly soft.
- **Grid snapping everywhere.** With the grid on, resizing a state, moving a
  multi-selection, and dragging free text now snap to the grid — matching how
  moving a single state already behaved.

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
