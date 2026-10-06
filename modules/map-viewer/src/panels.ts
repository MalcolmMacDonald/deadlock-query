import * as THREE from "three"
import { describe } from "./annotations.ts"
import { TOOL_IDS, type ToolId } from "./tools.ts"
import type { PanelComponent } from "./ViewerPanel.ts"
import type { ViewerController } from "./viewerService.ts"

export const VIEWER_LAYERS_PANEL_ID = "viewer.layers"
export const VIEWER_TOOLS_PANEL_ID = "viewer.tools"

const TOOL_LABELS: Record<ToolId, string> = {
  select: "Select", point: "Point", label: "Label", polyline: "Line", polygon: "Polygon", measure: "Measure"
}

/** `<input type=color>` only accepts #rrggbb. */
const hex = (css: string): string => `#${new THREE.Color(css).getHexString()}`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = "", props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (css) e.style.cssText = css
  return Object.assign(e, props)
}

const PANEL_CSS = "padding:8px;font:12px sans-serif;color:#d8dbe0;background:#1b1e24;height:100%;box-sizing:border-box;overflow:auto"

/** `viewer.layers`: visibility, colour, opacity and draw order of every overlay layer. */
export const makeLayersPanel = (controller: ViewerController): PanelComponent => ({
  mount: (container) => {
    const root = el("div", PANEL_CSS)
    root.dataset.testid = "viewer-layers"
    const list = el("div", "display:flex;flex-direction:column;gap:6px")
    const empty = el("div", "opacity:.6", { textContent: "No layers yet." })
    root.append(list, empty)
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
    render()
    const unsub = controller.layers.subscribe(render)
    return () => { unsub(); root.remove() }
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
    root.append(toolBar, actions, hint, list)
    container.appendChild(root)

    const toolButtons = TOOL_IDS.map((t) => {
      const b = el("button", "", { textContent: TOOL_LABELS[t] })
      b.dataset.tool = t
      b.onclick = () => controller.tools.setTool(t)
      toolBar.appendChild(b)
      return b
    })
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

    const HINTS: Record<ToolId, string> = {
      select: "Click an annotation to select it.",
      point: "Click the map to drop a point.",
      label: "Click the map, then type the label text.",
      polyline: "Click to add vertices; double-click or Enter to finish, Esc to cancel.",
      polygon: "Click to add vertices; double-click or Enter to close, Esc to cancel.",
      measure: "Click two points to measure."
    }
    const render = () => {
      const tool = controller.tools.tool
      for (const b of toolButtons) b.style.fontWeight = b.dataset.tool === tool ? "700" : "400"
      hint.textContent = controller.tools.pending ? `${HINTS[tool]} (${controller.tools.pending} placed)` : HINTS[tool]
      undo.disabled = !controller.annotations.canUndo
      redo.disabled = !controller.annotations.canRedo
      finish.disabled = controller.tools.pending === 0
      del.disabled = controller.selectedAnnotation === undefined
      list.replaceChildren(...controller.annotations.annotations.map((a) => {
        const row = el("button", `text-align:left;font-weight:${a.id === controller.selectedAnnotation ? 700 : 400}`, { textContent: describe(a) })
        row.dataset.annotation = a.id
        row.onclick = () => { controller.tools.setTool("select"); controller.selectAnnotation(a.id) }
        return row
      }))
    }
    render()
    const unsubs = [
      controller.tools.subscribe(render),
      controller.annotations.subscribe(render),
      controller.onSelectionChange(render)
    ]
    return () => { for (const u of unsubs) u(); root.remove() }
  }
})
