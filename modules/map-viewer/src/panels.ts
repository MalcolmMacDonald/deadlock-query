import * as THREE from "three"
import { describe, isHidden, isLocked } from "./annotations.ts"
import { TOOL_IDS, type BuiltinToolId } from "./tools.ts"
import type { PanelComponent } from "./ViewerPanel.ts"
import type { ViewerController } from "./viewerService.ts"
import { SURFACE_LABELS, type SurfaceKind } from "./surfaces.ts"

export const VIEWER_LAYERS_PANEL_ID = "viewer.layers"
export const VIEWER_TOOLS_PANEL_ID = "viewer.tools"

const TOOL_LABELS: Record<BuiltinToolId, string> = {
  select: "Select", point: "Point", label: "Label", polyline: "Line", polygon: "Polygon", measure: "Measure"
}

/** `<input type=color>` only accepts #rrggbb. */
const hex = (css: string): string => `#${new THREE.Color(css).getHexString()}`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = "", props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (css) e.style.cssText = css
  return Object.assign(e, props)
}

const PANEL_CSS = "padding:8px;font:12px sans-serif;color:var(--fg,#d8dbe0);background:var(--surface,#1b1e24);height:100%;box-sizing:border-box;overflow:auto"

/** `viewer.layers`: which map meshes show (render by default, collision on request), then visibility, colour, opacity and draw order of every overlay layer. */
export const makeLayersPanel = (controller: ViewerController): PanelComponent => ({
  mount: (container) => {
    const root = el("div", PANEL_CSS)
    root.dataset.testid = "viewer-layers"
    const surfacesBox = el("div", "display:flex;flex-direction:column;gap:4px;margin-bottom:10px")
    surfacesBox.dataset.role = "surfaces"
    surfacesBox.append(el("div", "font-weight:700", { textContent: "Map surfaces" }))
    const surfaceBoxes = (["render", "collision"] as const).map((kind: SurfaceKind) => {
      const label = el("label", "display:flex;align-items:center;gap:6px")
      label.dataset.surface = kind
      const box = el("input", "", { type: "checkbox" })
      box.dataset.role = "surface-visible"
      box.onchange = () => controller.surfaces.set(kind, box.checked)
      const name = el("span", "flex:1", { textContent: SURFACE_LABELS[kind] })
      label.append(box, name)
      surfacesBox.appendChild(label)
      return { kind, label, box, name }
    })
    const renderSurfaces = () => {
      for (const s of controller.surfaces.list()) {
        const r = surfaceBoxes.find((b) => b.kind === s.kind)!
        r.box.checked = s.visible
        r.box.disabled = !s.available
        r.name.textContent = s.available ? s.label : `${s.label} (not in this map)`
        r.label.style.opacity = s.available ? "1" : ".5"
      }
    }
    const list = el("div", "display:flex;flex-direction:column;gap:6px")
    const empty = el("div", "opacity:.6", { textContent: "No layers yet." })
    const groupsHeader = el("div", "display:flex;align-items:center;gap:6px;margin-top:12px;font-weight:700")
    groupsHeader.append(el("span", "flex:1", { textContent: "Annotation layers" }))
    const newGroup = el("button", "", { textContent: "New layer", title: "Add an annotation layer" })
    newGroup.dataset.action = "new-layer"
    newGroup.onclick = () => { const l = controller.annotations.addLayer(); controller.setActiveLayer(l.id) }
    groupsHeader.append(newGroup)
    const groups = el("div", "display:flex;flex-direction:column;gap:4px;margin-top:4px")
    groups.dataset.role = "doc-layers"
    root.append(surfacesBox, list, empty, groupsHeader, groups)
    container.appendChild(root)

    interface Row { readonly row: HTMLElement; readonly visible: HTMLInputElement; readonly color: HTMLInputElement; readonly opacity: HTMLInputElement; readonly name: HTMLElement }
    const rows = new Map<string, Row>()
    let signature = ""

    const makeRow = (id: string): Row => {
      const row = el("div", "display:grid;grid-template-columns:auto 1fr;gap:2px 6px;align-items:center")
      row.dataset.layer = id
      const controls = el("div", "display:flex;align-items:center;gap:6px;grid-column:1 / -1")
      const visible = el("input", "", { type: "checkbox", title: "Visible" })
      visible.dataset.role = "visible"
      const name = el("span", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap")
      const color = el("input", "width:28px;height:20px;padding:0", { type: "color", title: "Colour" })
      color.dataset.role = "color"
      const opacity = el("input", "width:64px", { type: "range", min: "0", max: "1", step: "0.05", title: "Opacity" })
      opacity.dataset.role = "opacity"
      const up = el("button", "", { textContent: "▲", title: "Move up (draw later)" })
      up.dataset.role = "up"
      const down = el("button", "", { textContent: "▼", title: "Move down" })
      down.dataset.role = "down"
      visible.onchange = () => controller.layers.patch(id, { visible: visible.checked })
      color.oninput = () => controller.layers.patch(id, { color: color.value })
      opacity.oninput = () => controller.layers.patch(id, { opacity: Number(opacity.value) })
      up.onclick = () => controller.layers.move(id, 1)
      down.onclick = () => controller.layers.move(id, -1)
      controls.append(color, opacity, up, down)
      row.append(visible, name, controls)
      return { row, visible, color, opacity, name }
    }

    const render = () => {
      // Top layer first, like a paint program.
      const layers = [...controller.layers.list()].reverse()
      const sig = layers.map((l) => l.id).join("\n")
      if (sig !== signature) {
        signature = sig
        for (const [id, r] of rows) if (!layers.some((l) => l.id === id)) { r.row.remove(); rows.delete(id) }
        for (const l of layers) {
          if (!rows.has(l.id)) rows.set(l.id, makeRow(l.id))
          list.appendChild(rows.get(l.id)!.row) // re-appending reorders
        }
      }
      for (const l of layers) {
        const r = rows.get(l.id)!
        r.name.textContent = l.label
        r.name.title = l.id
        r.visible.checked = l.visible
        r.opacity.value = String(l.opacity)
        r.color.value = hex(l.color ?? l.baseColor)
      }
      empty.style.display = layers.length ? "none" : ""
    }
    /** Document layers (`Annotation.layer`): which one new drawings go to, and whether it is visible or locked. */
    const renderGroups = () => {
      const docLayers = controller.annotations.layers ?? []
      groups.replaceChildren(
        ...(docLayers.length ? [el("div", "opacity:.6", { textContent: "● draw · visible · locked" })] : [el("div", "opacity:.6", { textContent: "Annotations are not grouped yet." })]),
        ...docLayers.map((l) => {
          const row = el("div", "display:flex;align-items:center;gap:6px")
          row.dataset.docLayer = l.id
          const active = el("input", "", { type: "radio", name: "active-layer", title: "Draw into this layer", checked: controller.activeLayer === l.id })
          active.dataset.role = "active"
          active.onchange = () => { controller.setActiveLayer(l.id); renderGroups() }
          const visible = el("input", "", { type: "checkbox", title: "Visible", checked: l.visible !== false })
          visible.dataset.role = "doc-visible"
          visible.onchange = () => controller.annotations.patchLayer(l.id, { visible: visible.checked })
          const locked = el("input", "", { type: "checkbox", title: "Locked: its annotations cannot be selected or edited", checked: l.locked === true })
          locked.dataset.role = "doc-locked"
          locked.onchange = () => controller.annotations.patchLayer(l.id, { locked: locked.checked })
          const name = el("span", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", { textContent: l.name, title: l.id })
          const move = el("button", "", { textContent: "Move selection here", title: "Move the selected annotations into this layer" })
          move.dataset.role = "doc-move"
          move.disabled = l.locked === true || controller.selection.length === 0
          move.onclick = () => controller.moveSelectionToLayer(l.id)
          row.append(active, visible, locked, name, move)
          return row
        })
      )
    }
    render()
    renderGroups()
    renderSurfaces()
    const unsubs = [
      controller.surfaces.subscribe(renderSurfaces),
      controller.layers.subscribe(render),
      controller.annotations.subscribe(renderGroups),
      controller.onSelectionChange(renderGroups)
    ]
    return () => { for (const u of unsubs) u(); root.remove() }
  }
})

/** `viewer.tools`: tool picker, undo/redo and the annotation list. */
export const makeToolsPanel = (controller: ViewerController): PanelComponent => ({
  mount: (container) => {
    const root = el("div", PANEL_CSS)
    root.dataset.testid = "viewer-tools"
    const toolBar = el("div", "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px")
    const actions = el("div", "display:flex;gap:4px;margin-bottom:6px")
    const hint = el("div", "opacity:.7;margin-bottom:6px;min-height:1.4em")
    const list = el("div", "display:flex;flex-direction:column;gap:2px")
    const selectionInfo = el("div", "margin-bottom:6px;opacity:.8")
    selectionInfo.dataset.role = "selection"
    const files = el("div", "display:flex;gap:4px;margin-bottom:6px")
    const status = el("div", "margin-bottom:6px;min-height:1.4em")
    status.dataset.role = "status"
    const snaps = el("div", "display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap")
    snaps.title = "Snapping"
    root.append(toolBar, actions, files, snaps, hint, status, selectionInfo, list)
    container.appendChild(root)

    const makeToolButton = (id: string, label: string) => {
      const b = el("button", "", { textContent: label })
      b.dataset.tool = id
      b.onclick = () => controller.tools.setTool(id)
      return b
    }
    const builtinButtons = TOOL_IDS.map((t) => makeToolButton(t, TOOL_LABELS[t]))
    toolBar.append(...builtinButtons)
    /** Buttons of tools other modules registered; rebuilt when the registry changes. */
    let externalButtons: HTMLButtonElement[] = []
    let externalSig = ""
    const action = (name: string, text: string, fn: () => void) => {
      const b = el("button", "", { textContent: text })
      b.dataset.action = name
      b.onclick = fn
      actions.appendChild(b)
      return b
    }
    const undo = action("undo", "Undo", () => controller.annotations.undo())
    const redo = action("redo", "Redo", () => controller.annotations.redo())
    const finish = action("finish", "Finish", () => controller.tools.finish())
    const del = action("delete", "Delete", () => controller.deleteSelected())

    const fileInput = el("input", "display:none") as HTMLInputElement
    fileInput.type = "file"
    fileInput.accept = "application/json,.json"
    fileInput.dataset.role = "import-file"
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0]
      fileInput.value = ""
      if (!file) return
      const result = controller.importJson(await file.text())
      status.textContent = result.ok
        ? `Imported ${result.doc.annotations.length} annotations${result.warnings.length ? ` (${result.warnings.join("; ")})` : ""}.`
        : `Import failed: ${result.error}`
    }
    const fileButton = (name: string, text: string, fn: () => void) => {
      const b = el("button", "", { textContent: text })
      b.dataset.action = name
      b.onclick = fn
      files.appendChild(b)
    }
    fileButton("export", "Export", () => {
      const url = URL.createObjectURL(new Blob([controller.exportJson()], { type: "application/json" }))
      const a = el("a", "", { href: url, download: `annotations-${controller.mapIdentity.mapName ?? "map"}.json` })
      a.click()
      URL.revokeObjectURL(url)
    })
    fileButton("import", "Import", () => fileInput.click())
    files.appendChild(fileInput)

    const snapBoxes = (["surface", "vertices", "features"] as const).map((k) => {
      const label = el("label", "display:flex;align-items:center;gap:3px")
      const box = el("input", "", { type: "checkbox" })
      box.dataset.snap = k
      box.onchange = () => controller.snapping.set({ [k]: box.checked })
      label.append(box, document.createTextNode(`Snap ${k}`))
      snaps.appendChild(label)
      return [k, box] as const
    })

    const HINTS: Record<BuiltinToolId, string> = {
      select: "Click to select, Shift-click to add. F frames the selection.",
      point: "Click the map to drop a point.",
      label: "Click the map, then type the label text.",
      polyline: "Click to add vertices; double-click or Enter to finish, Esc to cancel.",
      polygon: "Click to add vertices; double-click or Enter to close, Esc to cancel.",
      measure: "Click two points to measure."
    }
    /** Fuller help for the Select tool, shown as the hint's tooltip so the panel itself stays short. */
    const SELECT_DETAILS = "Click an annotation to select it (Shift/Ctrl-click adds or removes, Ctrl+A selects all); drag a blue handle to move a vertex, double-click an edge to add one, Delete removes the vertex (or the annotation); F frames the selection."
    const render = () => {
      const tool = controller.tools.tool
      const registered = controller.tools.registered
      const sig = registered.map((t) => `${t.id}\n${t.label}`).join("\n\n")
      if (sig !== externalSig) {
        externalSig = sig
        for (const b of externalButtons) b.remove()
        externalButtons = registered.map((t) => makeToolButton(t.id, t.label))
        toolBar.append(...externalButtons)
      }
      for (const b of [...builtinButtons, ...externalButtons]) b.style.fontWeight = b.dataset.tool === tool ? "700" : "400"
      const ext = registered.find((t) => t.id === tool)
      const baseHint = ext ? ext.hint ?? "" : HINTS[tool as BuiltinToolId] ?? ""
      for (const [k, box] of snapBoxes) box.checked = controller.snapping.settings[k]
      const status = controller.tools.status
      hint.textContent = ext
        ? status ? `${baseHint} ${status}`.trim() : baseHint
        : controller.tools.pending ? `${baseHint} (${controller.tools.pending} placed)` : baseHint
      hint.title = !ext && tool === "select" ? SELECT_DETAILS : ""
      undo.disabled = !controller.annotations.canUndo
      redo.disabled = !controller.annotations.canRedo
      finish.disabled = ext ? ext.finish === undefined : controller.tools.pending === 0
      del.disabled = controller.selection.length === 0
      const layers = controller.annotations.layers
      list.replaceChildren(...controller.annotations.annotations.map((a) => {
        const locked = isLocked(a, layers)
        const layerName = a.layer === undefined ? "" : ` [${layers?.find((l) => l.id === a.layer)?.name ?? a.layer}]`
        const row = el("button", `text-align:left;font-weight:${controller.selection.includes(a.id) ? 700 : 400}`, {
          textContent: `${locked ? "🔒 " : ""}${describe(a)}${layerName}`, disabled: locked || isHidden(a, layers)
        })
        row.dataset.annotation = a.id
        row.onclick = (ev) => {
          controller.tools.setTool("select")
          if (ev.shiftKey || ev.ctrlKey || ev.metaKey) controller.toggleAnnotation(a.id)
          else controller.selectAnnotation(a.id)
        }
        return row
      }))
      selectionInfo.textContent = controller.selection.length > 1 ? `${controller.selection.length} selected` : ""
    }
    render()
    const unsubs = [
      controller.tools.subscribe(render),
      controller.annotations.subscribe(render),
      controller.onSelectionChange(render),
      controller.snapping.subscribe(render)
    ]
    return () => { for (const u of unsubs) u(); root.remove() }
  }
})
