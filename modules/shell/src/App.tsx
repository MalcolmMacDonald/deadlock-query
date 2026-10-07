import { DockviewReact, themeDark, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview"
import "dockview/dist/styles/dockview.css"
import { type FunctionComponent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DevAuth } from "@deadlock-query/contracts"
import { Effect } from "effect"
import { buildCommands } from "./commands.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { ABOUT_PANEL_ID } from "./about.tsx"
import { addPreset, applyPreset, closeActivePanel, cyclePanel, moveActiveToNextGroup, showPanel, splitActive, toggleMaximizeActive } from "./dock.ts"
import { keepDockviewAriaValid } from "./dockviewAria.ts"
import { isRestorable, loadLayout, resetLayout, saveLayout } from "./layout.ts"
import { LockScreen } from "./LockScreen.tsx"
import { loginRequired, modules } from "./modules.ts"
import { availablePresets, DEFAULT_PRESET_ID, NARROW_WIDTH, PRESETS } from "./presets.ts"
import { ErrorPanel, toDockviewComponent } from "./panels.tsx"
import { appBaseLayer, composeModules, type Composition } from "./runtime.ts"
import { decodeLayoutHash, shareUrl, withoutLayoutParam } from "./share.ts"
import { matchShortcut, PALETTE_TOGGLE } from "./shortcuts.ts"
import { applyTheme, loadTheme, nextTheme, saveTheme, type Theme } from "./theme.ts"
import { notify } from "./toasts.ts"
import { Toaster } from "./Toaster.tsx"

export const App = () => {
  const [composition, setComposition] = useState<Composition>()
  const [fatal, setFatal] = useState<string>()
  useEffect(() => {
    composeModules(modules, appBaseLayer).then(setComposition, (e) => setFatal(String(e)))
  }, [])
  if (fatal) return <ErrorPanel moduleId="shell" message={fatal} />
  if (!composition) return <div style={{ padding: 12 }}>Loading…</div>
  return <AuthGate composition={composition}><Shell composition={composition} /></AuthGate>
}

const authenticated = (composition: Composition) =>
  composition.runtime.runPromise(Effect.gen(function* () { return (yield* (yield* DevAuth).status) === "authenticated" }))

/** On the dev site (dev-only modules shipped) nothing renders until `DevAuth` reports a session; prod never asks. */
const AuthGate = ({ composition, children }: { composition: Composition; children: ReactNode }) => {
  const [state, setState] = useState<"checking" | "locked" | "open">(loginRequired ? "checking" : "open")
  useEffect(() => {
    if (loginRequired) void authenticated(composition).then((ok) => setState(ok ? "open" : "locked"), () => setState("locked"))
  }, [composition])
  if (state === "checking") return <div style={{ padding: 12 }}>Loading…</div>
  if (state === "locked")
    return (
      <LockScreen
        login={(password) => composition.runtime.runPromise(Effect.gen(function* () { return yield* (yield* DevAuth).login(password) }))}
        onUnlocked={() => setState("open")}
      />
    )
  return <>{children}</>
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
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => (mainRef.current ? keepDockviewAriaValid(mainRef.current) : undefined), [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => loadTheme(localStorage))
  const presets = useMemo(() => availablePresets(panels), [panels])

  useEffect(() => {
    applyTheme(document, theme)
    saveTheme(localStorage, theme)
  }, [theme])

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
    if (api && preset) applyPreset(api, preset.build(panels, window.innerWidth < NARROW_WIDTH))
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
      () => notify("success", "Layout link copied"),
      () => {
        // No clipboard permission: leave the link in the address bar to copy by hand.
        history.replaceState(null, "", url)
        notify("info", "Copy the layout link from the address bar")
      },
    )
  }, [])

  const showPanelById = useCallback((id: string) => {
    const api = apiRef.current
    const def = panels.find((p) => p.id === id)
    if (api && def) showPanel(api, def)
  }, [panels])

  const commands = useMemo(
    () =>
      buildCommands(modules, presets, {
        showPanel: showPanelById,
        applyPreset: applyNamedPreset,
        resetLayout: resetToDefault,
        shareLayout: share,
        focusNext: () => apiRef.current && cyclePanel(apiRef.current, 1),
        focusPrevious: () => apiRef.current && cyclePanel(apiRef.current, -1),
        closeActive: () => {
          const title = apiRef.current && closeActivePanel(apiRef.current)
          if (title) notify("info", `Closed “${title}”. Reopen it from the command palette (Ctrl+K).`)
        },
        toggleMaximize: () => apiRef.current && toggleMaximizeActive(apiRef.current),
        moveToNextGroup: () => {
          if (apiRef.current && !moveActiveToNextGroup(apiRef.current)) notify("info", "There is no other panel group to move into.")
        },
        split: (direction) => {
          if (apiRef.current && !splitActive(apiRef.current, direction)) notify("info", "The active panel is alone in its group; there is nothing to split from.")
        },
        toggleTheme: () => setTheme(nextTheme),
      }),
    [presets, showPanelById, applyNamedPreset, resetToDefault, share],
  )

  // Global shortcuts come from the registry (capture phase, so panels such as Monaco cannot swallow them).
  useEffect(() => {
    const byId = new Map(commands.map((c) => [c.id, c]))
    const onKey = (e: KeyboardEvent) => {
      const s = matchShortcut(e)
      if (!s) return
      e.preventDefault()
      e.stopPropagation()
      if (s.command === PALETTE_TOGGLE) setPaletteOpen((open) => !open)
      else void Promise.resolve(byId.get(s.command)?.run()).catch((err) => notify("error", String(err)))
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [commands])

  // A layout link pasted into an already-open tab only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const api = apiRef.current
      const shared = decodeLayoutHash(location.hash)
      if (!api || shared === null) return
      if (restore(api, shared)) history.replaceState(null, "", location.pathname + location.search + withoutLayoutParam(location.hash))
      else notify("error", "That layout link does not match this version of the app")
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [restore])

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
        history.replaceState(null, "", location.pathname + location.search + withoutLayoutParam(location.hash))
      }
    }
    if (!restored) restored = restore(e.api, loadLayout(localStorage))
    if (!restored) addPreset(e.api, PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!.build(panels, window.innerWidth < NARROW_WIDTH))
    e.api.onDidLayoutChange(() => saveLayout(localStorage, e.api.toJSON()))
    ;(window as unknown as { __dockview: unknown }).__dockview = e.api
  }, [panels, restore])

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); apiRef.current?.activePanel?.focus() }}>Skip to the active panel</a>
      <header className="shell-header">
        <h1>Deadlock Query</h1>
        <div role="group" aria-label="Layout presets" style={{ display: "flex", gap: 4 }}>
          {presets.map((p) => (
            <button key={p.id} type="button" data-testid={`preset-${p.id}`} onClick={() => applyNamedPreset(p.id)}>{p.title}</button>
          ))}
        </div>
        <button type="button" data-testid="reset-layout" onClick={resetToDefault}>Reset layout</button>
        <button type="button" data-testid="share-layout" onClick={share}>Share layout</button>
        <button type="button" data-testid="open-palette" aria-keyshortcuts="Control+K" onClick={() => setPaletteOpen(true)}>Commands (Ctrl+K)</button>
        <button type="button" data-testid="toggle-theme" aria-pressed={theme === "light"} onClick={() => setTheme(nextTheme)}>{theme === "dark" ? "Light theme" : "Dark theme"}</button>
        <button type="button" data-testid="open-about" onClick={() => showPanelById(ABOUT_PANEL_ID)}>Help &amp; About</button>
      </header>
      <main id="main" ref={mainRef} style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact theme={theme === "dark" ? themeDark : themeLight} components={components} onReady={onReady} />
      </main>
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      <Toaster />
    </div>
  )
}
