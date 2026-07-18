# Changelog

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
