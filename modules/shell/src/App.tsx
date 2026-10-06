import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview"
import "dockview/dist/styles/dockview.css"
import { type FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildCommands } from "./commands.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { addPreset, applyPreset, showPanel } from "./dock.ts"
import { isRestorable, loadLayout, resetLayout, saveLayout } from "./layout.ts"
import { modules } from "./modules.ts"
import { availablePresets, DEFAULT_PRESET_ID, PRESETS } from "./presets.ts"
import { ErrorPanel, toDockviewComponent } from "./panels.tsx"
import { appBaseLayer, composeModules, type Composition } from "./runtime.ts"
import { decodeLayoutHash, shareUrl } from "./share.ts"

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
  const apiRef = useRef<DockviewApi>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notice, setNotice] = useState<string>()
  const presets = useMemo(() => availablePresets(panels), [panels])

  const flash = useCallback((message: string) => {
    setNotice(message)
    setTimeout(() => setNotice((n) => (n === message ? undefined : n)), 4000)
  }, [])

  /** Restores `layout` into `api` when every panel it names is registered; false (and a cleared dock) otherwise. */
  const restore = useCallback((api: DockviewApi, layout: unknown): boolean => {
    if (!isRestorable(layout, panels.map((p) => p.id))) return false
    try {
      api.fromJSON(layout as Parameters<typeof api.fromJSON>[0])
      return true
    } catch {
      api.clear()
      return false
    }
  }, [panels])

  const applyNamedPreset = useCallback((id: (typeof PRESETS)[number]["id"]) => {
    const api = apiRef.current
    const preset = PRESETS.find((p) => p.id === id)
    if (api && preset) applyPreset(api, preset.build(panels))
  }, [panels])

  const resetToDefault = useCallback(() => {
    resetLayout(localStorage)
    applyNamedPreset(DEFAULT_PRESET_ID)
  }, [applyNamedPreset])

  const share = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const url = shareUrl(location.href, api.toJSON())
    navigator.clipboard.writeText(url).then(
      () => flash("Layout link copied"),
      () => {
        // No clipboard permission: leave the link in the address bar to copy by hand.
        history.replaceState(null, "", url)
        flash("Copy the layout link from the address bar")
      },
    )
  }, [flash])

  const commands = useMemo(
    () =>
      buildCommands(modules, presets, {
        showPanel: (id) => {
          const api = apiRef.current
          const def = panels.find((p) => p.id === id)
          if (api && def) showPanel(api, def)
        },
        applyPreset: applyNamedPreset,
        resetLayout: resetToDefault,
        shareLayout: share,
      }),
    [presets, panels, applyNamedPreset, resetToDefault, share],
  )

  // Ctrl/Cmd+K toggles the palette from anywhere (capture phase, so panels such as Monaco cannot swallow it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  // A layout link pasted into an already-open tab only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const api = apiRef.current
      const shared = decodeLayoutHash(location.hash)
      if (!api || shared === null) return
      if (restore(api, shared)) history.replaceState(null, "", location.pathname + location.search)
      else flash("That layout link does not match this version of the app")
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [restore, flash])

  const onReady = useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api
    // Priority: a shared link in the URL hash, then the saved layout, then the default preset.
    const shared = decodeLayoutHash(location.hash)
    let restored = false
    if (shared !== null) {
      restored = restore(e.api, shared)
      if (restored) {
        // The change listener is not attached yet, so persist the adopted layout now or a reload would lose it.
        saveLayout(localStorage, e.api.toJSON())
        history.replaceState(null, "", location.pathname + location.search)
      }
    }
    if (!restored) restored = restore(e.api, loadLayout(localStorage))
    if (!restored) addPreset(e.api, PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!.build(panels))
    e.api.onDidLayoutChange(() => saveLayout(localStorage, e.api.toJSON()))
    ;(window as unknown as { __dockview: unknown }).__dockview = e.api
  }, [panels, restore])

  const button = { font: "inherit" } as const
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ padding: "4px 12px", display: "flex", gap: 12, alignItems: "center" }}>
        <strong>Deadlock Query</strong>
        <span role="group" aria-label="Layout presets" style={{ display: "flex", gap: 4 }}>
          {presets.map((p) => (
            <button key={p.id} style={button} data-testid={`preset-${p.id}`} onClick={() => applyNamedPreset(p.id)}>{p.title}</button>
          ))}
        </span>
        <button style={button} data-testid="reset-layout" onClick={resetToDefault}>Reset layout</button>
        <button style={button} data-testid="share-layout" onClick={share}>Share layout</button>
        <button style={button} data-testid="open-palette" aria-keyshortcuts="Control+K" onClick={() => setPaletteOpen(true)}>Commands (Ctrl+K)</button>
        <span role="status" data-testid="notice" style={{ opacity: 0.8 }}>{notice}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact className="dockview-theme-dark" components={components} onReady={onReady} />
      </div>
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
