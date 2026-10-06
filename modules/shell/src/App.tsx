import type { PanelDefinition } from "@deadlock-query/contracts"
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview"
import "dockview/dist/styles/dockview.css"
import { type FunctionComponent, useCallback, useEffect, useMemo, useState } from "react"
import { loadLayout, resetLayout, saveLayout } from "./layout.ts"
import { modules } from "./modules.ts"
import { ErrorPanel, toDockviewComponent } from "./panels.tsx"
import { appBaseLayer, composeModules, type Composition } from "./runtime.ts"

const directions = { left: "left", right: "right", top: "above", bottom: "below", float: "within" } as const

const addDefaults = (e: DockviewReadyEvent, panels: ReadonlyArray<PanelDefinition>) => {
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
  const [composition, setComposition] = useState<Composition>()
  const [fatal, setFatal] = useState<string>()
  useEffect(() => {
    composeModules(modules, appBaseLayer).then(setComposition, (e) => setFatal(String(e)))
  }, [])
  if (fatal) return <ErrorPanel moduleId="shell" message={fatal} />
  if (!composition) return <div style={{ padding: 12 }}>Loading…</div>
  return <Shell composition={composition} />
}

const Shell = ({ composition }: { composition: Composition }) => {
  const panels = useMemo(() => modules.flatMap((m) => m.panels), [])
  const components = useMemo(() => {
    const failures = new Map(composition.failed.map((f) => [f.moduleId, f.message]))
    const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {}
    for (const m of modules) {
      const message = failures.get(m.id)
      for (const p of m.panels) {
        out[p.id] = message === undefined
          ? toDockviewComponent(m.id, p)
          : () => <ErrorPanel moduleId={m.id} message={message} />
      }
    }
    return out
  }, [composition])
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
    if (!restored) addDefaults(e, panels)
    e.api.onDidLayoutChange(() => saveLayout(localStorage, e.api.toJSON()))
    ;(window as unknown as { __dockview: unknown }).__dockview = e.api
  }, [panels])

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
