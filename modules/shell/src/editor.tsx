import { Effect, Layer } from "effect"
import { MapDataService, MockMapDataService, SelectionBus, ViewerService, type ModuleDefinition } from "@deadlock-query/contracts"
import type { IDockviewPanelProps } from "dockview"
import { useEffect, useRef } from "react"
import { LazyPanel } from "./LazyPanel.tsx"
import { BUNDLE_MANIFEST_URL } from "./viewer.ts"

/** The query-library artifact `tools/build.ts` ships next to the standalone editor app (`editor/`). */
export const LIBRARY_URL = "./editor/library.json"

type QueryBundle = { readonly manifest: { readonly mapName: string; readonly gameBuildId: string }; readonly entities: ReadonlyArray<unknown> }

/** The entities queries run on: the published bundle when present, else the mini-map fixture (same choice as the Map panel). */
export const loadQueryBundle = async (manifestUrl = BUNDLE_MANIFEST_URL): Promise<QueryBundle> => {
  try {
    const base = new URL(manifestUrl, globalThis.location?.href)
    const res = await fetch(base)
    if (!res.ok) throw new Error(`${manifestUrl}: HTTP ${res.status}`)
    const manifest = (await res.json()) as { mapName: string; gameBuildId: string; entitiesFile: string }
    const er = await fetch(new URL(manifest.entitiesFile, base))
    if (!er.ok) throw new Error(`${manifest.entitiesFile}: HTTP ${er.status}`)
    return { manifest, entities: ((await er.json()) as { entities: ReadonlyArray<unknown> }).entities }
  } catch {
    return Effect.runPromise(
      Effect.gen(function* () {
        const data = yield* MapDataService
        return { manifest: yield* data.manifest, entities: yield* data.entities } as QueryBundle
      }).pipe(Effect.provide(MockMapDataService)),
    )
  }
}

type Services = { readonly viewer: (typeof ViewerService)["Service"]; readonly selection: (typeof SelectionBus)["Service"] }
let resolveServices!: (s: Services) => void
const services = new Promise<Services>((resolve) => { resolveServices = resolve })

/** Hands the runtime's shared `ViewerService` / `SelectionBus` instances to the panel (it takes values, not layers). */
const captureServices = Layer.effectDiscard(
  Effect.gen(function* () {
    resolveServices({ viewer: yield* ViewerService, selection: yield* SelectionBus })
  }),
)

/**
 * A share link the page was opened with (`#q=…&api=…`): the shell owns the URL, so it hands the fragment to the editor,
 * once. It only fills the editor and is never run; reopening the panel later must not overwrite the user's edits.
 */
let pendingShare: string | undefined = typeof location !== "undefined" && location.hash.length > 1 ? location.hash : undefined
export const takeInitialShare = (): string | undefined => {
  const share = pendingShare
  pendingShare = undefined
  return share
}

/** Starts downloading Monaco and the TypeScript worker in the background so the editor tab opens quickly. */
export const prefetchEditor = (): void => {
  void Promise.all([import("@deadlock-query/query-builder"), import("./monacoWorkers.ts")])
    .then(([qb, { monacoWorkerUrl }]) => qb.prefetchQueryEditor({ getWorkerUrl: monacoWorkerUrl }))
    .catch(() => {})
}

/** Mounts query-builder's embeddable panel (Monaco loads lazily, with the shell's real viewer and selection). */
const mountEditor = (container: HTMLElement): (() => void) => {
  let dispose = () => {}
  let cancelled = false
  void Promise.all([import("@deadlock-query/query-builder"), import("./monacoWorkers.ts"), services])
    .then(([qb, { monacoWorkerUrl }, { viewer, selection }]) => {
      if (cancelled) return
      const initialShare = takeInitialShare()
      dispose = qb.makeQueryEditorPanel({
        library: qb.fetchLibraryArtifact(LIBRARY_URL),
        bundle: loadQueryBundle(),
        viewer,
        selection,
        getWorkerUrl: monacoWorkerUrl,
        ...(initialShare ? { initialShare } : {}),
      }).mount(container)
    })
    .catch((e) => {
      container.textContent = `Query editor failed to load: ${String(e)}`
    })
  return () => { cancelled = true; dispose() }
}

const EditorHost = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => mountEditor(ref.current!), [])
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />
}

export const editorModule: ModuleDefinition<ViewerService | SelectionBus> = {
  id: "query-builder",
  layer: captureServices,
  panels: [
    {
      id: "query.editor",
      title: "Query",
      defaultPlacement: "right",
      component: ({ api }: IDockviewPanelProps) => <LazyPanel api={api}>{() => <EditorHost />}</LazyPanel>,
    },
  ],
}
