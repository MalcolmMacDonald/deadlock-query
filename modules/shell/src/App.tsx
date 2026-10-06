import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview"
import "dockview/dist/styles/dockview.css"
import type { FunctionComponent } from "react"
import { useCallback } from "react"
import { loadLayout, resetLayout, saveLayout } from "./layout.ts"
import { modules } from "./modules.ts"

const panels = modules.flatMap((m) => m.panels)
const components: Record<string, FunctionComponent<IDockviewPanelProps>> = Object.fromEntries(
  panels.map((p) => [p.id, p.component as FunctionComponent<IDockviewPanelProps>]),
)

const directions = { left: "left", right: "right", top: "above", bottom: "below", float: "within" } as const

const addDefaults = (e: DockviewReadyEvent) => {
  let prev: string | undefined
  for (const p of panels) {
    const position =
      prev === undefined || p.defaultPlacement === "center"
        ? undefined
        : { referencePanel: prev, direction: directions[p.defaultPlacement] }
    e.api.addPanel({ id: p.id, title: p.title, component: p.id, ...(position ? { position } : {}) })
    prev = p.id
  }
}

export const App = () => {
  const onReady = useCallback((e: DockviewReadyEvent) => {
    const saved = loadLayout(localStorage)
    let restored = false
    if (saved) {
      try {
        e.api.fromJSON(saved as Parameters<typeof e.api.fromJSON>[0])
        restored = true
      } catch {
        e.api.clear()
      }
    }
    if (!restored) addDefaults(e)
    e.api.onDidLayoutChange(() => saveLayout(localStorage, e.api.toJSON()))
    ;(window as unknown as { __dockview: unknown }).__dockview = e.api
  }, [])

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ padding: "4px 12px", display: "flex", gap: 12, alignItems: "center" }}>
        <strong>Deadlock Query</strong>
        <button onClick={() => { resetLayout(localStorage); location.reload() }}>Reset layout</button>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact className="dockview-theme-dark" components={components} onReady={onReady} />
      </div>
    </div>
  )
}
