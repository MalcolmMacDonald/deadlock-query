import { Effect, Layer } from "effect"
import { MapDataService, MockMapDataService, type ModuleDefinition } from "@deadlock-query/contracts"
import { Fragment, useEffect, useState } from "react"
import { PALETTE_TOGGLE, SHORTCUTS, shortcutLabel } from "./shortcuts.ts"
import { buildInfo } from "./buildInfo.ts"
import { LIBRARY_URL } from "./editor.tsx"
import { BUNDLE_MANIFEST_URL } from "./viewer.ts"

export const ABOUT_PANEL_ID = "shell.about"

export interface AboutData {
  /** Where the map data came from: the published bundle, or the built-in mini-map fixture. */
  readonly mapSource: "bundle" | "fixture"
  readonly mapName: string
  readonly gameBuildId: string
  /** The query library's API version, or null when `library.json` could not be read. */
  readonly libraryApiVersion: string | null
}

const fixtureManifest = () =>
  Effect.runPromise(Effect.gen(function* () { return yield* (yield* MapDataService).manifest }).pipe(Effect.provide(MockMapDataService)))

/** Game build id, map and query-library API version: the published files when present, else the fixture / "unavailable". */
export const loadAboutData = async (fetchFn: typeof fetch = fetch, base: string = globalThis.location?.href ?? "http://localhost/"): Promise<AboutData> => {
  const getJson = async (url: string) => {
    const res = await fetchFn(new URL(url, base))
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }
  const [manifest, library] = await Promise.all([
    getJson(BUNDLE_MANIFEST_URL).then(
      (m) => ({ source: "bundle" as const, mapName: String(m.mapName), gameBuildId: String(m.gameBuildId) }),
      async () => ({ source: "fixture" as const, ...(await fixtureManifest()) }),
    ),
    getJson(LIBRARY_URL).then((l) => (typeof l.apiVersion === "string" ? l.apiVersion : null), () => null),
  ])
  return { mapSource: manifest.source, mapName: manifest.mapName, gameBuildId: manifest.gameBuildId, libraryApiVersion: library }
}

const SHORTCUT_TEXT: Record<string, string> = {
  [PALETTE_TOGGLE]: "Open the command palette (every panel, preset and action)",
  "panel:next": "Focus the next panel",
  "panel:previous": "Focus the previous panel",
  "panel:close-active": "Close the active panel",
  "panel:maximize-active": "Maximize or restore the active panel",
  "panel:wider": "Widen the active panel group",
  "panel:narrower": "Narrow the active panel group",
  "panel:taller": "Make the active panel group taller",
  "panel:shorter": "Make the active panel group shorter",
}

const AboutPanel = () => {
  const [data, setData] = useState<AboutData>()
  useEffect(() => {
    let live = true
    void loadAboutData().then((d) => live && setData(d), () => {})
    return () => { live = false }
  }, [])
  return (
    <section className="about" tabIndex={0} aria-labelledby="about-title" data-testid="about-panel">
      <h2 id="about-title" style={{ marginTop: 0 }}>About Deadlock Query</h2>
      <h3>Getting started</h3>
      <ol data-testid="about-start">
        <li>Write a query in the editor on the right and press Ctrl+Enter; the results appear as points on the map.</li>
        <li>Click a result row to fly to it; click a point on the map to see its details in the Inspector.</li>
        <li>Open Docs or Gallery in the editor for the query API and ready-made examples.</li>
        <li>The header presets (Query, Explore, Review) rearrange the panels; Reset layout restores the default.</li>
      </ol>
      <h3>Keyboard shortcuts</h3>
      <dl data-testid="about-shortcuts">
        {SHORTCUTS.map((s) => (<Fragment key={s.command}><dt><kbd>{shortcutLabel(s)}</kbd></dt><dd>{SHORTCUT_TEXT[s.command] ?? s.command}</dd></Fragment>))}
        <dt><kbd>F</kbd></dt><dd>On the map: frame the selection</dd>
      </dl>
      <h3>Build</h3>
      <dl>
        <dt>Build</dt><dd data-testid="about-sha"><code>{buildInfo.gitSha}</code> ({buildInfo.target})</dd>
        <dt>Built at</dt><dd>{buildInfo.builtAt}</dd>
        <dt>Game build</dt><dd data-testid="about-game-build">{data ? data.gameBuildId : "loading…"}</dd>
        <dt>Map</dt><dd>{data ? `${data.mapName} (${data.mapSource === "bundle" ? "published bundle" : "built-in fixture"})` : "loading…"}</dd>
        <dt>Query library API</dt><dd data-testid="about-api-version">{data ? (data.libraryApiVersion ?? "unavailable") : "loading…"}</dd>
      </dl>
    </section>
  )
}

/** The shell's own module: the About panel (floating; reopen it from the header or the command palette). */
export const shellModule: ModuleDefinition = {
  id: "shell",
  layer: Layer.empty,
  panels: [{ id: ABOUT_PANEL_ID, title: "About", defaultPlacement: "float", component: AboutPanel }],
}
