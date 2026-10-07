# map-viewer: controls

Click the map once so it has keyboard focus (a blue ring shows for keyboard focus).

## Camera

| Mode (keys `1` `2` `3`) | Mouse | Keyboard | Touch |
| --- | --- | --- | --- |
| Map | drag pans, wheel zooms | arrows pan, `+` / `-` zoom | one finger pans, two fingers pinch and pan |
| Orbit | drag turns around the target, right-drag or Shift-drag pans, wheel zooms | arrows turn, `+` / `-` zoom | two fingers pinch and pan |
| Fly | drag looks, wheel sets speed | `W A S D` move, `Q E` down / up, arrows look | two fingers pinch and pan |

Hold Shift with the arrow keys or `+` / `-` for three times the step. `R` or `Home` returns to the home view, `F` frames the selected features. The camera is stored in the URL hash, so a link restores the view.

## Annotations

Pick a tool in the Tools panel (Select, Point, Label, Polyline, Polygon, Measure). `Enter` finishes a line or polygon, `Escape` cancels, `Delete` removes the selection or the selected vertex, `Ctrl+Z` / `Ctrl+Y` undo and redo, `Ctrl+A` selects all. Shift- or Ctrl-click adds to the selection.

## Panels and theme

Layers, Tools and Inspector follow the shell's light or dark theme through its CSS variables (`--fg`, `--surface`, `--muted`, `--border`). The 3D canvas stays dark in both themes.
