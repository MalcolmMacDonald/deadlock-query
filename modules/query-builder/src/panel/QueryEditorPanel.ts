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
import { buildDocIndex, insertionFor, type DocIndex, type DocItem } from "../docs/catalog.ts"
import { makeQueryEngine } from "../engine/engine.ts"
import { makeFriendly } from "../engine/friendly.ts"
import { buildExport, isProvisional, type ExportFile, type ExportFormat, type ExportMeta } from "../export/exports.ts"
import { globalsShim, toPrelude, type LibraryArtifact } from "../engine/prelude.ts"
import type { GalleryQuery } from "../gallery/queries.ts"
import { checkApiVersion, decodeShare, encodeShare } from "../share/shareLink.ts"
import { makeQueryStore, type KeyValueStorage, type QueryStore } from "../store/queryStore.ts"
import { SandboxRunner } from "../sandbox/runner.ts"
import { downloadBlob } from "../ui/download.ts"
import { renderExportBar } from "../ui/exportBar.ts"
import { registerDocsHover } from "../ui/docsHover.ts"
import { renderSavedPanes } from "../ui/savedPanes.ts"
import { renderSidebar, type Sidebar, type SidebarTab } from "../ui/sidebar.ts"
import { registerSnippetCompletions } from "../ui/snippetCompletions.ts"

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
  /** Open the docs/gallery sidebar on this tab at mount. Default: closed (the header buttons toggle it). */
  readonly initialSidebar?: SidebarTab
  /** URL fragment of a share link (`q=…&api=…`, with or without `#`). It fills the editor; it is never run. */
  readonly initialShare?: string
  /** Page URL (without fragment) that "Share" appends the query to. Default: the current page. */
  readonly shareBaseUrl?: () => string
  /** Where saved queries and history live. Default: `localStorage` (memory only when it is unavailable). */
  readonly storage?: KeyValueStorage
}

export interface QueryEditorHandle {
  readonly dispose: () => void
  readonly editor: monaco.editor.IStandaloneCodeEditor
  readonly run: () => Promise<void>
  readonly cancel: () => void
  readonly runner: SandboxRunner
  /** Docs/gallery/saved/history sidebar (no Docs tab when the library artifact carries no `apiCatalog`). */
  readonly sidebar: Sidebar
  readonly store: QueryStore
  /** The share link for the current editor content. */
  readonly shareUrl: () => Promise<string>
}

const DEFAULT_SOURCE = `map.guardians
  .select((g) => [g.id, g.position, map.healingOrbs.closest(g)!.id])
  .toArray()
`
const STYLE_ID = "dlq-qb-style"
const STYLE = `
.dlq-qb{display:flex;flex-direction:column;height:100%;min-height:0;background:#1e1e1e;color:#ddd;font:13px system-ui,sans-serif}
.dlq-qb header{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #333}
.dlq-qb .qb-body{flex:1;display:flex;min-height:0}
.dlq-qb .qb-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.dlq-qb .qb-editor{height:40%;min-height:160px}
.dlq-qb .qb-results{flex:1;overflow:auto;padding:8px}
.dlq-qb .qb-side{width:340px;flex:none;display:flex;flex-direction:column;border-left:1px solid #333;min-height:0}
.dlq-qb .qb-side[hidden]{display:none}
.dlq-qb .qb-side .tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #333}
.dlq-qb .qb-side .tabs .active,.dlq-qb header .active{background:#264f78}
.dlq-qb .qb-side .pane{flex:1;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.dlq-qb .qb-side .pane[hidden]{display:none}
.dlq-qb .qb-side .docs{overflow:hidden}
.dlq-qb .doc-list{flex:0 1 45%;overflow:auto;display:flex;flex-direction:column;border:1px solid #333}
.dlq-qb .doc-list .cat{background:#252526;padding:2px 6px;font-weight:600;position:sticky;top:0}
.dlq-qb .doc-list .doc-item{text-align:left;background:none;border:0;color:inherit;padding:2px 10px;cursor:pointer;font:12px ui-monospace,monospace}
.dlq-qb .doc-list .doc-item:hover,.dlq-qb .doc-list .doc-item.selected{background:#264f78}
.dlq-qb .doc-detail{flex:1;overflow:auto}
.dlq-qb .doc-detail .kind{color:#999}
.dlq-qb .qb-side pre{background:#252526;padding:6px;margin:4px 0;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}
.dlq-qb .card{border:1px solid #333;padding:8px;display:flex;flex-direction:column;gap:4px}
.dlq-qb .export-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px}
.dlq-qb .export-bar .provisional{color:#e2c08d}
.dlq-qb .notices .notice{padding:4px 8px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center}
.dlq-qb .notices .notice.warning{background:#5a4a1a}.dlq-qb .notices .notice.error{background:#5a1d1d}.dlq-qb .notices .notice.info{background:#1f3a52}
.dlq-qb .notices .notice input{flex:1;min-width:0}
.dlq-qb .notices .notice button{margin-left:auto}
.dlq-qb .qb-side input{min-width:0}.dlq-qb .qb-side .actions{flex-wrap:wrap}.dlq-qb .qb-side .empty{color:#999}
.dlq-qb .card p{margin:0}.dlq-qb .card .needs{color:#999}.dlq-qb .card .actions{display:flex;gap:6px}
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

const defaultStorage = (): KeyValueStorage | undefined => { try { return localStorage } catch { return undefined } }

/** Clipboard write that reports failure instead of throwing (blocked in iframes without permission, insecure pages). */
const copyText = async (doc: Document, text: string): Promise<boolean> => {
  try { await doc.defaultView!.navigator.clipboard.writeText(text); return true } catch { return false }
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
    rootEl.innerHTML = `<header><button id="run" type="button">Run (Ctrl+Enter)</button><button id="cancel" type="button" disabled>Cancel</button><span id="status">idle</span><span style="flex:1"></span><button id="share" type="button" data-testid="share" title="Copy a link to this query">Share</button><span id="side-toggles"></span></header><div class="qb-body"><div class="qb-main"><div id="notices" class="notices"></div><div id="editor" class="qb-editor"></div><div id="results" class="qb-results"></div></div></div>`
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

    const docIndex: DocIndex | undefined = lib.catalog ? buildDocIndex(lib.catalog) : undefined
    const modelUri = monaco.Uri.parse("file:///query.ts")
    const model = monaco.editor.createModel(opts.initialSource ?? DEFAULT_SOURCE, "typescript", modelUri)
    cleanups.push(() => model.dispose())
    const editor = monaco.editor.create(q("#editor"), { model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false } })
    cleanups.push(() => editor.dispose())

    const runner = new SandboxRunner(doc, toPrelude(lib.js))
    cleanups.push(() => runner.dispose())
    await runner.load(bundle)
    const compilerModelUri = monaco.Uri.parse("file:///engine/query.ts")
    cleanups.push(() => monaco.editor.getModel(compilerModelUri)?.dispose())
    const engineLayer = makeQueryEngine({ compiler: monacoCompiler(monaco), runner, ...(docIndex ? { friendly: makeFriendly(docIndex) } : {}) })
    const servicesLayer = Layer.mergeAll(Layer.succeed(ViewerService)(opts.viewer), Layer.succeed(SelectionBus)(opts.selection))
    const layerId = opts.overlayLayerId ?? "query-result"
    const { viewer, selection } = opts
    const fire = (e: Effect.Effect<unknown>) => void Effect.runPromise(e.pipe(Effect.ignore))

    // Notices above the editor: share-link and library-version warnings, export problems.
    const notices = q("#notices")
    const clearNotices = () => notices.replaceChildren()
    const notify = (kind: "info" | "warning" | "error", text: string, extra?: HTMLElement) => {
      const n = doc.createElement("div")
      n.className = `notice ${kind}`
      n.dataset.testid = "notice"
      const t = doc.createElement("span")
      t.textContent = text
      const x = doc.createElement("button")
      x.type = "button"
      x.textContent = "Dismiss"
      x.addEventListener("click", () => n.remove())
      n.append(t, ...(extra ? [extra] : []), x)
      notices.replaceChildren(n)
    }

    const store = makeQueryStore(opts.storage ?? defaultStorage())
    const download = (filename: string, mime: string, text: string) => downloadBlob(doc, filename, new Blob([text], { type: mime }))
    /** Puts `source` in the editor as an edit (Ctrl+Z restores the previous text); never runs it. */
    const loadSource = (source: string, apiVersion?: string) => {
      clearNotices()
      editor.executeEdits("dlq-load", [{ range: model.getFullModelRange(), text: source }])
      editor.setPosition({ lineNumber: 1, column: 1 })
      editor.focus()
      if (apiVersion !== undefined) {
        const v = checkApiVersion(apiVersion, lib.apiVersion)
        if (v.kind !== "same") notify("warning", v.message)
      }
    }

    // Docs/gallery/saved/history sidebar, hover links into the docs, snippet completions.
    cleanups.push(registerSnippetCompletions(monaco, modelUri).dispose)
    const insertAtCursor = (text: string, cursorBack: number) => {
      const sel = editor.getSelection() ?? model.getFullModelRange()
      editor.executeEdits("dlq-docs", [{ range: sel, text, forceMoveMarkers: true }])
      const end = editor.getPosition()
      if (end && cursorBack > 0) editor.setPosition({ lineNumber: end.lineNumber, column: end.column - cursorBack })
      editor.focus()
    }
    const panes = renderSavedPanes(doc, { store, apiVersion: lib.apiVersion, getSource: () => model.getValue(), loadSource, download })
    const sidebar: Sidebar = renderSidebar(doc, {
      ...(docIndex ? { index: docIndex } : {}),
      saved: panes.saved,
      history: panes.history,
      onInsert: (item: DocItem) => {
        const pos = editor.getPosition() ?? model.getFullModelRange().getEndPosition()
        const ins = insertionFor(item, model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: pos.column }))
        insertAtCursor(ins.text, ins.cursorBack)
      },
      onInsertExample: (source) => insertAtCursor(source, 0),
      onLoadQuery: (query: GalleryQuery, runNow: boolean) => {
        loadSource(query.source)
        if (runNow) void run()
      },
    })
    sidebar.el.hidden = true
    const toggles = q("#side-toggles")
    const syncToggles = () => {
      for (const b of Array.from(toggles.querySelectorAll("button"))) b.classList.toggle("active", !sidebar.el.hidden && b.dataset.tab === sidebar.el.dataset.tab)
    }
    const toggle = (tab: SidebarTab) => {
      const closing = !sidebar.el.hidden && sidebar.el.dataset.tab === tab
      sidebar.el.hidden = closing
      if (!closing) sidebar.show(tab)
      syncToggles()
    }
    const tabs: ReadonlyArray<readonly [SidebarTab, string]> = [...(docIndex ? [["docs", "Docs"] as const] : []), ["gallery", "Gallery"], ["saved", "Saved"], ["history", "History"]]
    for (const [tab, label] of tabs) {
      const b = doc.createElement("button")
      b.type = "button"
      b.textContent = label
      b.dataset.tab = tab
      b.dataset.testid = `toggle-${tab}`
      b.addEventListener("click", () => toggle(tab))
      toggles.append(b)
    }
    q(".qb-body").append(sidebar.el)
    if (docIndex) cleanups.push(registerDocsHover(monaco, docIndex, modelUri, (id) => { sidebar.el.hidden = false; sidebar.showDoc(id); syncToggles() }).dispose)
    if (opts.initialSidebar) toggle(opts.initialSidebar)

    // Share links: the query and the library version it was written for, in the URL fragment.
    const shareUrl = async () => {
      const base = (opts.shareBaseUrl ?? (() => `${doc.defaultView!.location.origin}${doc.defaultView!.location.pathname}${doc.defaultView!.location.search}`))()
      return `${base}#${await encodeShare({ source: model.getValue(), apiVersion: lib.apiVersion })}`
    }
    q("#share").addEventListener("click", () => {
      void shareUrl().then(async (url) => {
        const field = doc.createElement("input")
        field.readOnly = true
        field.value = url
        field.dataset.testid = "share-url"
        const copied = await copyText(doc, url)
        notify("info", copied ? "Link copied. Opening it fills the editor but never runs the query:" : "Copy this link. Opening it fills the editor but never runs the query:", field)
        field.select()
      }).catch((e) => notify("error", `Could not make a share link: ${e instanceof Error ? e.message : String(e)}`))
    })
    if (opts.initialShare) {
      try {
        const shared = await decodeShare(opts.initialShare)
        if (shared) {
          editor.executeEdits("dlq-share", [{ range: model.getFullModelRange(), text: shared.source }])
          const v = checkApiVersion(shared.apiVersion, lib.apiVersion)
          notify("warning", `Loaded from a share link. It has not been run: read it, then press Run.${v.kind === "same" ? "" : ` ${v.message}`}`)
        }
      } catch (e) {
        notify("error", e instanceof Error ? e.message : String(e))
      }
    }

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
    let lastRunSource = model.getValue()
    let features = overlayFeatures({ columns: [], rows: [], rowIds: [], geometryColumns: [] } as unknown as QueryResult)
    let selectedRowIds: ReadonlyArray<string> = []
    const renderTable = () => {
      if (!currentResult) return
      const result = currentResult
      const meta: ExportMeta = { source: lastRunSource, apiVersion: lib.apiVersion, mapName: bundle.manifest.mapName, gameBuildId: bundle.manifest.gameBuildId }
      const attempt = (f: () => void | Promise<void>) => { void Promise.resolve().then(f).catch((e) => notify("error", e instanceof Error ? e.message : String(e))) }
      const saveFile = (f: ExportFile) => downloadBlob(doc, f.filename, new Blob([f.text], { type: f.mime }))
      out.replaceChildren(
        renderExportBar(doc, {
          provisional: isProvisional(result),
          onExport: (format: ExportFormat) => attempt(() => saveFile(buildExport(result, format, meta))),
          onCopy: (format) => attempt(async () => {
            if (!(await copyText(doc, buildExport(result, format, meta).text))) throw new Error("The browser did not allow copying to the clipboard.")
            notify("info", `Copied the result as ${format.toUpperCase()}.`)
          }),
          onPng: () => attempt(async () => {
            const png = await Effect.runPromise(viewer.captureImage)
            if (png.length === 0) throw new Error("The map view returned no image (is the map visible?).")
            downloadBlob(doc, `query-result${isProvisional(result) ? ".provisional" : ""}.png`, new Blob([png as BlobPart], { type: "image/png" }))
          })
        }),
        renderResults(doc, result, {
          selectedRows: new Set(selectedRowIds),
          onRowSelect: (rowId: string) => applySelection([rowId], true)
        })
      )
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
      clearNotices()
      const source = model.getValue()
      lastRunSource = source
      try {
        const { result } = await runQuery(engineLayer, source)
        store.record({ source, status: "ok", rows: result.stats.rowCount })
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
        if (!(e instanceof Error && e.message === "Query cancelled.")) store.record({ source, status: "error", error: err.textContent ?? "" })
        status.textContent = "error"
        currentResult = null
      } finally {
        runBtn.disabled = false
        cancelBtn.disabled = true
        panes.refresh()
      }
    }
    const cancel = () => void Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(engineLayer)))
    runBtn.addEventListener("click", () => void run())
    cancelBtn.addEventListener("click", cancel)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run())
    return { dispose, editor, run, cancel, runner, sidebar, store, shareUrl }
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
