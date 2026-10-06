import { Effect, Layer } from "effect"
import { MapDataService, MockMapDataService, type ModuleDefinition } from "@deadlock-query/contracts"
import { useEffect, useState } from "react"
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

const AboutPanel = () => {
  const [data, setData] = useState<AboutData>()
  useEffect(() => {
    let live = true
    void loadAboutData().then((d) => live && setData(d), () => {})
    return () => { live = false }
  }, [])
  return (
    <section className="about" aria-labelledby="about-title" data-testid="about-panel">
      <h2 id="about-title" style={{ marginTop: 0 }}>About Deadlock Query</h2>
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
