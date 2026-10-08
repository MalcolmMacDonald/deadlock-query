import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js"
import "./monacoContributions.ts"
import { Effect, Layer, Stream } from "effect"
import { QueryEngine, SelectionBus, ViewerService, type QueryResult } from "@deadlock-query/contracts"
import { runQuery } from "../app/engine.ts"
import { monacoCompiler } from "../app/monacoCompiler.ts"
import { entityLabel } from "../results/entityLabel.ts"
import { createResultsTable, type ResultsTable } from "../results/resultsTable.ts"
import { featureFocus, overlayFeatures, setResultOverlay } from "../app/viewerIntegration.ts"
import { buildDocIndex, insertionFor, type DocIndex, type DocItem } from "../docs/catalog.ts"
import { makeQueryEngine } from "../engine/engine.ts"
import { makeFriendly } from "../engine/friendly.ts"
import { buildExport, isProvisional, type ExportFile, type ExportFormat, type ExportMeta } from "../export/exports.ts"
import { globalsShim, toPrelude, type LibraryArtifact } from "../engine/prelude.ts"
import type { GalleryQuery } from "../gallery/queries.ts"
import { checkApiVersion, decodeShare, encodeShare } from "../share/shareLink.ts"
import { makeQueryStore, type KeyValueStorage, type QueryStore } from "../store/queryStore.ts"
import { SandboxRunner, type BakedBuffers } from "../sandbox/runner.ts"
import { STYLE } from "../ui/styles.ts"
import { downloadBlob } from "../ui/download.ts"
import { renderExportBar } from "../ui/exportBar.ts"
import { renderProblems, summarizeProblems } from "../ui/problems.ts"
import { registerDocsHover } from "../ui/docsHover.ts"
import { renderSavedPanes } from "../ui/savedPanes.ts"
import { renderSidebar, type Sidebar, type SidebarTab } from "../ui/sidebar.ts"
import { registerSnippetCompletions } from "../ui/snippetCompletions.ts"

/** The map data a query runs against (what the library's `MapContext.fromBundle` takes). */
export interface QueryBundle {
  readonly manifest: { readonly mapName: string; readonly gameBuildId: string }
  readonly entities: ReadonlyArray<unknown>
  /**
   * Baked spatial data (`baked/collision.bvh`, `baked/navmesh.bin`) as buffers or as URLs the panel downloads. With it the
   * worker gets a raycaster and navmesh, so travel-time, line-of-sight and height queries run on the real map.
   */
  readonly baked?: { readonly bvh?: ArrayBuffer | string; readonly navmesh?: ArrayBuffer | string }
}

/** Downloads the baked files named by URL; buffers pass through. Undefined when the bundle has none. */
const resolveBaked = async (baked: QueryBundle["baked"]): Promise<BakedBuffers | undefined> => {
  if (!baked) return undefined
  const get = async (v: ArrayBuffer | string | undefined): Promise<ArrayBuffer | undefined> => {
    if (v === undefined || typeof v !== "string") return v
    const res = await fetch(v)
    if (!res.ok) throw new Error(`${v}: HTTP ${res.status}`)
    return res.arrayBuffer()
  }
  const [bvh, navmesh] = await Promise.all([get(baked.bvh), get(baked.navmesh)])
  return bvh || navmesh ? { ...(bvh ? { bvh } : {}), ...(navmesh ? { navmesh } : {}) } : undefined
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

// Object rows give the result table real column names (array rows would be c1, c2, ...).
const DEFAULT_SOURCE = `map.guardians
  .select((g) => ({ guardian: g.id, position: g.position, nearestHealingOrb: map.healingOrbs.closest(g)!.id }))
  .toArray()
`
const STYLE_ID = "dlq-qb-style"
const SELECTION_POLL_MS = 250
const SHORTCUTS = "Ctrl+Enter runs the query. Ctrl+Space shows suggestions, Ctrl+Shift+Space parameter hints, F12 goes to a definition, Ctrl+F finds. Tab indents; press Ctrl+M first to make Tab and Shift+Tab move focus out of the editor. In the results table: Tab to enter it, Arrow keys, Home and End move between rows, Enter or Space selects a row, Page Up and Page Down change page. Escape closes the sidebar."

let active = false
let configured = false

const configureMonacoOnce = () => {
  if (configured) return
  configured = true
  const ts = monaco.languages.typescript
  ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true, strict: true })
  ts.typescriptDefaults.setEagerModelSync(true)
  // Parameter names next to literal arguments (`inLane("yellow")` reads `inLane(lane: "yellow")`): the library's calls are terse.
  ts.typescriptDefaults.setInlayHintsOptions({ includeInlayParameterNameHints: "literals", includeInlayParameterNameHintsWhenArgumentMatchesName: false })
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
    const entityIndex = new Map<string, unknown>()
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style")
      style.id = STYLE_ID
      style.textContent = STYLE
      doc.head.append(style)
    }
    const rootEl = doc.createElement("div")
    rootEl.className = "dlq-qb"
    rootEl.innerHTML = `<header><button id="run" type="button" aria-keyshortcuts="Control+Enter">Run (Ctrl+Enter)</button><button id="cancel" type="button" disabled>Cancel</button><button id="pin" type="button" data-testid="pin" disabled title="Keep this result on the map while you run other queries">Pin</button><button id="unpin" type="button" data-testid="unpin" hidden>Unpin all</button><span id="status" role="status" aria-live="polite">idle</span><span style="flex:1"></span><button id="problems-toggle" type="button" data-testid="problems-toggle" aria-expanded="false" aria-controls="qb-problems">No problems</button><button id="shortcuts" type="button" data-testid="shortcuts">Keys</button><button id="share" type="button" data-testid="share" title="Copy a link to this query">Share</button><span id="side-toggles" role="group" aria-label="Sidebar"></span></header><div class="qb-body"><div class="qb-main"><div id="notices" class="notices"></div><div id="editor" class="qb-editor" role="region" aria-label="Query editor"></div><div id="qb-problems" class="problems" data-testid="problems" role="region" aria-label="Problems" hidden></div><div id="results" class="qb-results" role="region" aria-label="Results" tabindex="-1"></div></div></div>`
    container.append(rootEl)
    cleanups.push(() => rootEl.remove())
    const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel)!
    const runBtn = q<HTMLButtonElement>("#run")
    const cancelBtn = q<HTMLButtonElement>("#cancel")
    const pinBtn = q<HTMLButtonElement>("#pin")
    const unpinBtn = q<HTMLButtonElement>("#unpin")
    const status = q("#status")
    const out = q("#results")
    out.innerHTML = `<p class="empty" data-testid="results-empty">Press Run (Ctrl+Enter) to run the query. Rows appear here, and as points on the map.</p>`

    const ts = monaco.languages.typescript
    for (const [name, text] of Object.entries(lib.dts)) cleanups.push(ts.typescriptDefaults.addExtraLib(text, `file:///library/${name}`).dispose)
    cleanups.push(ts.typescriptDefaults.addExtraLib(globalsShim(lib), "file:///library/globals.d.ts").dispose)

    const docIndex: DocIndex | undefined = lib.catalog ? buildDocIndex(lib.catalog) : undefined
    const modelUri = monaco.Uri.parse("file:///query.ts")
    const model = monaco.editor.createModel(opts.initialSource ?? DEFAULT_SOURCE, "typescript", modelUri)
    cleanups.push(() => model.dispose())
    const editor = monaco.editor.create(q("#editor"), {
      model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false },
      // Tab inserts indentation by default; Ctrl+M switches Tab to move focus, so keyboard users can leave the editor.
      ariaLabel: "Query editor. Press Control+M to make Tab move focus out of the editor.",
      accessibilitySupport: "auto", renderWhitespace: "none", inlayHints: { enabled: "on" }
    })
    cleanups.push(() => editor.dispose())

    const baked = await resolveBaked(bundle.baked)
    const { baked: _urls, ...plainBundle } = bundle
    const runner = new SandboxRunner(doc, toPrelude(lib.js, baked ? lib.spatial : undefined))
    cleanups.push(() => runner.dispose())
    await runner.load(plainBundle, baked)
    for (const e of bundle.entities) { const id = (e as { id?: unknown }).id; if (typeof id === "string") entityIndex.set(id, e) }
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
      n.setAttribute("role", kind === "error" ? "alert" : "status")
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
      onClose: () => {
        sidebar.el.hidden = true
        syncToggles()
        toggles.querySelector<HTMLButtonElement>(`[data-tab="${sidebar.el.dataset.tab}"]`)?.focus()
      },
      onLoadQuery: (query: GalleryQuery, runNow: boolean) => {
        loadSource(query.source)
        if (runNow) void run()
      },
    })
    sidebar.el.hidden = true
    const toggles = q("#side-toggles")
    const syncToggles = () => {
      for (const b of Array.from(toggles.querySelectorAll("button"))) {
        const on = !sidebar.el.hidden && b.dataset.tab === sidebar.el.dataset.tab
        b.classList.toggle("active", on)
        b.setAttribute("aria-expanded", String(on))
      }
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
    sidebar.el.id = "qb-sidebar"
    for (const b of Array.from(toggles.querySelectorAll("button"))) b.setAttribute("aria-controls", "qb-sidebar")
    q(".qb-body").append(sidebar.el)
    if (docIndex) cleanups.push(registerDocsHover(monaco, docIndex, modelUri, (id) => { sidebar.el.hidden = false; sidebar.showDoc(id); syncToggles() }).dispose)
    if (opts.initialSidebar) toggle(opts.initialSidebar)

    // Share links: the query and the library version it was written for, in the URL fragment.
    const shareUrl = async () => {
      const base = (opts.shareBaseUrl ?? (() => `${doc.defaultView!.location.origin}${doc.defaultView!.location.pathname}${doc.defaultView!.location.search}`))()
      return `${base}#${await encodeShare({ source: model.getValue(), apiVersion: lib.apiVersion })}`
    }
    q("#shortcuts").addEventListener("click", () => notify("info", SHORTCUTS))
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
    const problemsToggle = q<HTMLButtonElement>("#problems-toggle")
    const problemsEl = q("#qb-problems")
    problemsToggle.addEventListener("click", () => {
      problemsEl.hidden = !problemsEl.hidden
      problemsToggle.setAttribute("aria-expanded", String(!problemsEl.hidden))
    })
    const goToProblem = (d: { line: number; column: number }) => {
      editor.setPosition({ lineNumber: d.line, column: d.column })
      editor.revealLineInCenterIfOutsideViewport(d.line)
      editor.focus()
    }
    const check = () =>
      Effect.runPromise(Effect.gen(function* () { return yield* (yield* QueryEngine).check(model.getValue()) }).pipe(Effect.provide(engineLayer))).then((ds) => {
        monaco.editor.setModelMarkers(model, "query", ds.map((d) => ({
          message: d.message, startLineNumber: d.line, startColumn: d.column, endLineNumber: d.line, endColumn: d.column + 1,
          severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
        })))
        const summary = summarizeProblems(ds)
        problemsToggle.textContent = summary.label
        problemsToggle.classList.toggle("has-errors", summary.errors > 0)
        problemsToggle.classList.toggle("has-warnings", summary.errors === 0 && summary.warnings > 0)
        renderProblems(doc, problemsEl, ds, goToProblem)
      }).catch(() => {})
    const sub = model.onDidChangeContent(() => { clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 300) })
    cleanups.push(() => { clearTimeout(checkTimer); sub.dispose() })
    void check()

    // Result ↔ viewer ↔ shared selection.
    let currentResult: QueryResult | null = null
    let lastRunSource = model.getValue()
    let features = overlayFeatures({ columns: [], rows: [], rowIds: [], geometryColumns: [] } as unknown as QueryResult, layerId)
    /** Viewer layers the current result occupies (one per geometry column). */
    let resultLayers: ReadonlyArray<string> = [layerId]
    let selectedRowIds: ReadonlyArray<string> = []
    let table: ResultsTable | null = null
    /** Builds the export bar and the table for the current result (once per run; selection changes only update row marks). */
    const showResult = () => {
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
        (table = createResultsTable(doc, result, {
          selectedRows: new Set(selectedRowIds),
          onRowSelect: (rowId: string) => { applySelection([rowId], true); focusRow(rowId) },
          describeEntity: (id) => entityLabel(entityIndex.get(id), id),
          onEntityClick: (rowId, column, entityId) => focusEntity(rowId, column, entityId)
        })).el
      )
    }
    /** Adopts `ids` as the selection: table highlight, viewer highlight, and (when it came from here) the shared bus. */
    const applySelection = (ids: ReadonlyArray<string>, publish: boolean) => {
      if (sameIds(ids, selectedRowIds) && !publish) return
      selectedRowIds = ids
      table?.setSelected(new Set(ids))
      fire(viewer.highlight(ids.flatMap((id) => features.rowToFeatures.get(id) ?? [])))
      if (publish) fire(selection.select(ids))
    }
    /** Flies the map camera to a result row's first feature (a row clicked in the table; a map pick is already under the camera). */
    const focusRow = (rowId: string) => {
      const featureId = features.rowToFeatures.get(rowId)?.[0]
      const sep = featureId?.lastIndexOf(":") ?? -1
      if (featureId === undefined || sep < 0) return
      const layer = features.layers.find((l) => l.id === featureId.slice(0, sep))
      const at = featureFocus(layer?.features[Number(featureId.slice(sep + 1))])
      if (at) fire(viewer.flyTo(at))
    }
    /** A clicked entity cell (e.g. `nearestHealingOrb`): fly to that entity, and highlight its point in this row when the column is an entity column (so it has a `.position` feature). */
    const focusEntity = (rowId: string, column: string, entityId: string) => {
      const layer = features.layers.find((l) => l.column === `${column}.position`)
      const featureId = layer ? features.rowToFeatures.get(rowId)?.find((f) => f.startsWith(`${layer.id}:`)) : undefined
      if (featureId) fire(viewer.highlight([featureId]))
      const at = (entityIndex.get(entityId) as { position?: readonly [number, number, number] } | undefined)?.position
      if (at) fire(viewer.flyTo(at))
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
    // External selection changes (the viewer's or another panel's): the bus's `changes` stream when it has one, else polling `current`.
    const adoptExternal = (ids: ReadonlyArray<string>) => applySelection(ids.filter((id) => currentResult?.rowIds.includes(id)), false)
    if (selection.changes) {
      const changesFiber = new AbortController()
      void Effect.runPromise(Stream.runForEach(selection.changes, (ids) => Effect.sync(() => adoptExternal(ids))).pipe(Effect.ignore), { signal: changesFiber.signal })
      void Effect.runPromise(selection.current).then(adoptExternal).catch(() => {})
      cleanups.push(() => changesFiber.abort())
    } else {
      const poll = setInterval(() => { void Effect.runPromise(selection.current).then(adoptExternal).catch(() => {}) }, SELECTION_POLL_MS)
      cleanups.push(() => clearInterval(poll))
    }
    cleanups.push(() => fire(Effect.all([...[...new Set([layerId, ...resultLayers])].map((id) => viewer.removeOverlay(id)), viewer.highlight([])], { discard: true })))

    const run = async () => {
      runBtn.disabled = true
      cancelBtn.disabled = false
      status.textContent = "running…"
      // progress(f) / ctx.progress(f) from the query (library >= 0.5): shown next to the status.
      runner.onProgress = (fraction, label) => { status.textContent = `running… ${Math.round(fraction * 100)}%${label ? ` ${label}` : ""}` }
      clearNotices()
      const source = model.getValue()
      lastRunSource = source
      try {
        const { result } = await runQuery(engineLayer, source)
        store.record({ source, status: "ok", rows: result.stats.rowCount })
        currentResult = result
        features = overlayFeatures(result, layerId)
        resultLayers = await Effect.runPromise(setResultOverlay(layerId, result, resultLayers).pipe(Effect.provide(servicesLayer))).catch(() => resultLayers)
        selectedRowIds = []
        showResult()
        pinBtn.disabled = false
        status.textContent = "done"
      } catch (e) {
        const err = doc.createElement("pre")
        err.className = "error"
        err.dataset.testid = "error"
        err.textContent = e instanceof Error ? e.message : String(e)
        out.replaceChildren(err)
        if (!(e instanceof Error && e.message === "Query cancelled.")) store.record({ source, status: "error", error: err.textContent ?? "" })
        status.textContent = e instanceof Error && e.message === "Query cancelled." ? "cancelled" : "error"
        currentResult = null
        pinBtn.disabled = true
        table = null
      } finally {
        runner.onProgress = undefined
        runBtn.disabled = false
        cancelBtn.disabled = true
        panes.refresh()
      }
    }
    const cancel = () => void Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(engineLayer)))
    runBtn.addEventListener("click", () => void run())
    cancelBtn.addEventListener("click", cancel)
    // Pinned results: copies of the current result's layers under their own ids, so the next run does not replace them.
    let pinned: string[] = []
    let pinCount = 0
    pinBtn.addEventListener("click", () => {
      if (!currentResult) return
      const n = ++pinCount
      const ids: string[] = []
      for (const l of overlayFeatures(currentResult, layerId).layers) {
        const id = `${layerId}-pin${n}~${ids.length}`
        ids.push(id)
        fire(viewer.setOverlay(id, l.features, l.style))
      }
      pinned.push(...ids)
      unpinBtn.hidden = pinned.length === 0
      status.textContent = `pinned (${pinned.length} layer${pinned.length === 1 ? "" : "s"})`
    })
    unpinBtn.addEventListener("click", () => {
      fire(Effect.all(pinned.map((id) => viewer.removeOverlay(id)), { discard: true }))
      pinned = []
      unpinBtn.hidden = true
      status.textContent = "unpinned"
    })
    cleanups.push(() => fire(Effect.all(pinned.map((id) => viewer.removeOverlay(id)), { discard: true })))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run())
    return { dispose, editor, run, cancel, runner, sidebar, store, shareUrl }
  } catch (e) {
    dispose()
    throw e
  }
}
