// Deliberately light: no value import of Monaco, Effect or the panel. The heavy code (Monaco is ~2.5 MB
// minified) is a dynamic import started by `mount`, so the shell pays for this file only until then.
import type { QueryBundle, QueryEditorHandle, QueryEditorPanelOptions } from "./QueryEditorPanel.ts"
import type { LibraryArtifact } from "../engine/prelude.ts"
import { fetchJsonCached, resolveLoadable, type Loadable } from "../load/progress.ts"
import { renderLoadingView } from "../load/loadingView.ts"

export type LazyQueryEditorPanelOptions = Omit<QueryEditorPanelOptions, "library" | "bundle"> & {
  readonly library: Loadable<LibraryArtifact>
  readonly bundle: Loadable<QueryBundle>
}

const defaultWorkerUrl = (label: string) => (label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js")

const loadPanelModule = () => import("./QueryEditorPanel.ts")

/**
 * Starts downloading the heavy parts ahead of time (call it when the shell is idle, or on hover over
 * the editor tab): the panel code with Monaco, and the TypeScript worker, the largest single file.
 * Safe to call repeatedly and to ignore; failures only mean the real mount downloads them later.
 */
export const prefetchQueryEditor = (opts: { readonly getWorkerUrl?: (label: string) => string } = {}): Promise<void> => {
  const worker = (opts.getWorkerUrl ?? defaultWorkerUrl)("typescript")
  void fetch(worker, { priority: "low" } as RequestInit).then((r) => r.arrayBuffer()).catch(() => {})
  return loadPanelModule().then(() => {}, () => {})
}

/**
 * Mounts the panel into `container`: a loading view with one progress bar per step (editor code,
 * library, map data) shows immediately; the editor replaces it once everything is ready. A failed
 * step shows its error with a Retry button.
 */
export const mountQueryEditor = async (container: HTMLElement, opts: LazyQueryEditorPanelOptions): Promise<QueryEditorHandle> => {
  const doc = container.ownerDocument
  const root = doc.createElement("div")
  Object.assign(root.style, { position: "relative", width: "100%", height: "100%" })
  const host = doc.createElement("div")
  Object.assign(host.style, { width: "100%", height: "100%" })
  root.append(host)
  container.append(root)
  const view = renderLoadingView(doc)
  root.append(view.el)
  let disposed = false
  let handle: QueryEditorHandle | undefined
  const dispose = () => { disposed = true; handle?.dispose(); root.remove() }

  const attempt = async (): Promise<QueryEditorHandle> => {
    view.phase("Loading the query editor…")
    const editor = view.step("editor", "Editor")
    const library = view.step("library", "Query library")
    const map = view.step("map", "Map data")
    const track = <T>(step: { done: () => void }, p: Promise<T>) => p.then((v) => { step.done(); return v })
    const [mod, lib, bundle] = await Promise.all([
      track(editor, loadPanelModule()),
      track(library, resolveLoadable(opts.library, library.progress)),
      track(map, resolveLoadable(opts.bundle, map.progress)),
    ])
    if (disposed) throw new Error("disposed")
    view.phase("Starting the editor…")
    const h = await mod.mountQueryEditor(host, { ...opts, library: lib, bundle })
    if (disposed) { h.dispose(); throw new Error("disposed") }
    view.el.remove()
    return h
  }

  return new Promise<QueryEditorHandle>((resolve, reject) => {
    const go = () => {
      attempt().then(
        (h) => { handle = h; resolve({ ...h, dispose }) },
        (e) => {
          if (disposed) return reject(e)
          view.fail(e instanceof Error ? e.message : String(e), () => { view.reset(); go() })
        }
      )
    }
    go()
  })
}

/**
 * Panel definition in the shell's `{ mount(container) => dispose }` shape. Import this package
 * lazily (`import("@deadlock-query/query-builder")`): that pulls in only this loader; Monaco follows
 * when `mount` runs (or earlier, via `prefetchQueryEditor`).
 */
export const makeQueryEditorPanel = (opts: LazyQueryEditorPanelOptions) => ({
  mount: (container: HTMLElement): (() => void) => {
    let dispose = () => {}
    let cancelled = false
    void mountQueryEditor(container, opts).then(
      (h) => { dispose = h.dispose; if (cancelled) h.dispose() },
      () => {}
    )
    return () => { cancelled = true; dispose() }
  }
})

/** Fetches a `library.json` (as written next to the standalone app, e.g. `./editor/library.json`), once per page, with progress. */
export const fetchLibraryArtifact = (url: string): Loadable<LibraryArtifact> => (report) => fetchJsonCached<LibraryArtifact>(url, report)

/** Same for a `bundle.json`-style `{ manifest, entities }` download. */
export const fetchQueryBundle = (url: string): Loadable<QueryBundle> => (report) => fetchJsonCached<QueryBundle>(url, report)

/**
 * A published bundle by its `manifest.json` URL: the manifest, `entities.json` and, when the manifest has a `baked` record,
 * the URLs of `collision.bvh` and `navmesh.bin` (the panel downloads those). Pass the result as the panel's `bundle`.
 */
export const fetchPublishedBundle = (manifestUrl: string): Loadable<QueryBundle> => async (report) => {
  const base = new URL(manifestUrl, globalThis.location?.href)
  const manifest = await fetchJsonCached<{ mapName: string; gameBuildId: string; entitiesFile: string; baked?: { bvh?: { file: string }; navmesh?: { file: string } } }>(base.href, report)
  const entities = await fetchJsonCached<{ entities: ReadonlyArray<unknown> }>(new URL(manifest.entitiesFile, base).href, report)
  const at = (f: string | undefined) => (f ? new URL(f, base).href : undefined)
  const bvh = at(manifest.baked?.bvh?.file)
  const navmesh = at(manifest.baked?.navmesh?.file)
  return {
    manifest: { mapName: manifest.mapName, gameBuildId: manifest.gameBuildId },
    entities: entities.entities,
    ...(bvh || navmesh ? { baked: { ...(bvh ? { bvh } : {}), ...(navmesh ? { navmesh } : {}) } } : {}),
  }
}
