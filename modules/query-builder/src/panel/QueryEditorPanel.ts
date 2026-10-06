import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js"
import "monaco-editor/esm/vs/editor/editor.all.js"
import { Effect, Layer, Stream } from "effect"
import { QueryEngine, SelectionBus, ViewerService, type QueryResult } from "@deadlock-query/contracts"
import { runQuery } from "../app/engine.ts"
import { monacoCompiler } from "../app/monacoCompiler.ts"
import { renderResults } from "../app/resultsTable.ts"
import { overlayFeatures, setResultOverlay } from "../app/viewerIntegration.ts"
import { makeQueryEngine } from "../engine/engine.ts"
import { globalsShim, toPrelude, type LibraryArtifact } from "../engine/prelude.ts"
import { SandboxRunner } from "../sandbox/runner.ts"

/** The map data a query runs against (what the library's `MapContext.fromBundle` takes). */
export interface QueryBundle {
  readonly manifest: { readonly mapName: string; readonly gameBuildId: string }
  readonly entities: ReadonlyArray<unknown>
}

export type ViewerServiceShape = (typeof ViewerService)["Service"]
export type SelectionBusShape = (typeof SelectionBus)["Service"]

export interface QueryEditorPanelOptions {
  /** The built query-library (`library.json` next to the standalone app, or `readLibraryArtifact`). */
  readonly library: LibraryArtifact | Promise<LibraryArtifact>
  readonly bundle: QueryBundle | Promise<QueryBundle>
  /** The real viewer: receives the result overlay and highlights; its `pick` events select rows. */
  readonly viewer: ViewerServiceShape
  /** The shared selection: row clicks publish to it, and external changes select rows in the table. */
  readonly selection: SelectionBusShape
  /** Where Monaco's `editor.worker.js` / `ts.worker.js` are served. Default: next to the page. */
  readonly getWorkerUrl?: (label: string) => string
  readonly initialSource?: string
  /** Viewer overlay layer id. Default `"query-result"`. */
  readonly overlayLayerId?: string
}

export interface QueryEditorHandle {
  readonly dispose: () => void
  readonly editor: monaco.editor.IStandaloneCodeEditor
  readonly run: () => Promise<void>
  readonly cancel: () => void
  readonly runner: SandboxRunner
}

const DEFAULT_SOURCE = `map.guardians
  .select((g) => [g.id, g.position, map.healingOrbs.closest(g)!.id])
  .toArray()
`
const STYLE_ID = "dlq-qb-style"
const STYLE = `
.dlq-qb{display:flex;flex-direction:column;height:100%;min-height:0;background:#1e1e1e;color:#ddd;font:13px system-ui,sans-serif}
.dlq-qb header{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #333}
.dlq-qb .qb-editor{height:40%;min-height:160px}
.dlq-qb .qb-results{flex:1;overflow:auto;padding:8px}
.dlq-qb table{border-collapse:collapse}.dlq-qb th,.dlq-qb td{border:1px solid #333;padding:2px 8px;text-align:left}.dlq-qb th{background:#252526}
.dlq-qb tr.selected td{background:#264f78}
.dlq-qb .error{color:#f48771;white-space:pre-wrap}.dlq-qb .warning{background:#5a4a1a;padding:2px 6px;margin:4px 0}
`
const SELECTION_POLL_MS = 250

let active = false
let configured = false

const configureMonacoOnce = () => {
  if (configured) return
  configured = true
  const ts = monaco.languages.typescript
  ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true, strict: true })
  ts.typescriptDefaults.setEagerModelSync(true)
}

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Mounts the editor, results table and sandboxed runner into `container`, wired to the given
 * viewer and selection services. One instance at a time (Monaco's TS defaults are process-global);
 * `dispose` releases everything, including the sandbox iframe and the viewer overlay.
 */
export const mountQueryEditor = async (container: HTMLElement, opts: QueryEditorPanelOptions): Promise<QueryEditorHandle> => {
  if (active) throw new Error("The query editor is already mounted; dispose it before mounting another.")
  active = true
  const cleanups: Array<() => void> = []
  const dispose = () => {
    if (!active) return
    active = false
    for (const c of cleanups.reverse()) { try { c() } catch (e) { console.warn("query editor cleanup failed:", e) } }
    cleanups.length = 0
  }
  try {
    const getWorkerUrl = opts.getWorkerUrl ?? ((label: string) => (label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js"))
    ;(self as any).MonacoEnvironment = { getWorkerUrl: (_: string, label: string) => getWorkerUrl(label) }
    configureMonacoOnce()
    const [lib, bundle] = await Promise.all([opts.library, opts.bundle])

    const doc = container.ownerDocument
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style")
      style.id = STYLE_ID
      style.textContent = STYLE
      doc.head.append(style)
    }
    const rootEl = doc.createElement("div")
    rootEl.className = "dlq-qb"
    rootEl.innerHTML = `<header><button id="run" type="button">Run (Ctrl+Enter)</button><button id="cancel" type="button" disabled>Cancel</button><span id="status">idle</span></header><div id="editor" class="qb-editor"></div><div id="results" class="qb-results"></div>`
    container.append(rootEl)
    cleanups.push(() => rootEl.remove())
    const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel)!
    const runBtn = q<HTMLButtonElement>("#run")
    const cancelBtn = q<HTMLButtonElement>("#cancel")
    const status = q("#status")
    const out = q("#results")

    const ts = monaco.languages.typescript
    for (const [name, text] of Object.entries(lib.dts)) cleanups.push(ts.typescriptDefaults.addExtraLib(text, `file:///library/${name}`).dispose)
    cleanups.push(ts.typescriptDefaults.addExtraLib(globalsShim(lib), "file:///library/globals.d.ts").dispose)

    const model = monaco.editor.createModel(opts.initialSource ?? DEFAULT_SOURCE, "typescript", monaco.Uri.parse("file:///query.ts"))
    cleanups.push(() => model.dispose())
    const editor = monaco.editor.create(q("#editor"), { model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false } })
    cleanups.push(() => editor.dispose())

    const runner = new SandboxRunner(doc, toPrelude(lib.js))
    cleanups.push(() => runner.dispose())
    await runner.load(bundle)
    const compilerModelUri = monaco.Uri.parse("file:///engine/query.ts")
    cleanups.push(() => monaco.editor.getModel(compilerModelUri)?.dispose())
    const engineLayer = makeQueryEngine({ compiler: monacoCompiler(monaco), runner })
    const servicesLayer = Layer.mergeAll(Layer.succeed(ViewerService)(opts.viewer), Layer.succeed(SelectionBus)(opts.selection))
    const layerId = opts.overlayLayerId ?? "query-result"
    const { viewer, selection } = opts
    const fire = (e: Effect.Effect<unknown>) => void Effect.runPromise(e.pipe(Effect.ignore))

    // Live diagnostics as markers on the visible model (same service the engine uses).
    let checkTimer: ReturnType<typeof setTimeout> | undefined
    const check = () =>
      Effect.runPromise(Effect.gen(function* () { return yield* (yield* QueryEngine).check(model.getValue()) }).pipe(Effect.provide(engineLayer))).then((ds) =>
        monaco.editor.setModelMarkers(model, "query", ds.map((d) => ({
          message: d.message, startLineNumber: d.line, startColumn: d.column, endLineNumber: d.line, endColumn: d.column + 1,
          severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
        })))).catch(() => {})
    const sub = model.onDidChangeContent(() => { clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 300) })
    cleanups.push(() => { clearTimeout(checkTimer); sub.dispose() })

    // Result ↔ viewer ↔ shared selection.
    let currentResult: QueryResult | null = null
    let features = overlayFeatures({ columns: [], rows: [], rowIds: [], geometryColumns: [] } as unknown as QueryResult)
    let selectedRowIds: ReadonlyArray<string> = []
    const renderTable = () => {
      if (!currentResult) return
      out.replaceChildren(renderResults(doc, currentResult, {
        selectedRows: new Set(selectedRowIds),
        onRowSelect: (rowId: string) => applySelection([rowId], true)
      }))
    }
    /** Adopts `ids` as the selection: table highlight, viewer highlight, and (when it came from here) the shared bus. */
    const applySelection = (ids: ReadonlyArray<string>, publish: boolean) => {
      if (sameIds(ids, selectedRowIds) && !publish) return
      selectedRowIds = ids
      renderTable()
      fire(viewer.highlight(ids.flatMap((id) => features.rowToFeatures.get(id) ?? [])))
      if (publish) fire(selection.select(ids))
    }
    const pickFiber = new AbortController()
    void Effect.runPromise(
      Stream.runForEach(viewer.events, (ev) => Effect.sync(() => {
        const rowId = ev._tag === "pick" ? features.featureToRow.get(ev.id) : undefined
        if (rowId !== undefined) applySelection([rowId], true)
      })).pipe(Effect.ignore),
      { signal: pickFiber.signal }
    )
    cleanups.push(() => pickFiber.abort())
    // `SelectionBus` has no change stream yet, so external selection changes are polled.
    const poll = setInterval(() => {
      void Effect.runPromise(selection.current).then((ids) => applySelection(ids.filter((id) => currentResult?.rowIds.includes(id)), false)).catch(() => {})
    }, SELECTION_POLL_MS)
    cleanups.push(() => clearInterval(poll))
    cleanups.push(() => fire(Effect.all([viewer.removeOverlay(layerId), viewer.highlight([])], { discard: true })))

    const run = async () => {
      runBtn.disabled = true
      cancelBtn.disabled = false
      status.textContent = "running…"
      try {
        const { result } = await runQuery(engineLayer, model.getValue())
        currentResult = result
        features = overlayFeatures(result)
        await Effect.runPromise(setResultOverlay(layerId, result).pipe(Effect.provide(servicesLayer))).catch(() => {})
        selectedRowIds = []
        renderTable()
        status.textContent = "done"
      } catch (e) {
        const err = doc.createElement("pre")
        err.className = "error"
        err.dataset.testid = "error"
        err.textContent = e instanceof Error ? e.message : String(e)
        out.replaceChildren(err)
        status.textContent = "error"
        currentResult = null
      } finally {
        runBtn.disabled = false
        cancelBtn.disabled = true
      }
    }
    const cancel = () => void Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(engineLayer)))
    runBtn.addEventListener("click", () => void run())
    cancelBtn.addEventListener("click", cancel)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run())
    return { dispose, editor, run, cancel, runner }
  } catch (e) {
    dispose()
    throw e
  }
}

/**
 * Panel definition in the shell's `{ mount(container) => dispose }` shape. Import this package
 * lazily (`import("@deadlock-query/query-builder")`) so Monaco stays out of the initial bundle.
 */
export const makeQueryEditorPanel = (opts: QueryEditorPanelOptions) => ({
  mount: (container: HTMLElement): (() => void) => {
    let handle: QueryEditorHandle | undefined
    let cancelled = false
    void mountQueryEditor(container, opts).then(
      (h) => { if (cancelled) h.dispose(); else handle = h },
      (e) => { if (!cancelled) container.textContent = `Query editor failed to load: ${e instanceof Error ? e.message : String(e)}` }
    )
    return () => { cancelled = true; handle?.dispose() }
  }
})
