import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js"
import "monaco-editor/esm/vs/editor/editor.all.js"
import { Effect, Layer } from "effect"
import { QueryEngine, MockViewerService, MockSelectionBus, type QueryResult } from "@deadlock-query/contracts"
import { runQuery } from "./engine.ts"
import { renderResults } from "./resultsTable.ts"
import { monacoCompiler } from "./monacoCompiler.ts"
import { makeQueryEngine } from "../engine/engine.ts"
import { globalsShim, toPrelude, type LibraryArtifact } from "../engine/library.ts"
import { SandboxRunner } from "../sandbox/runner.ts"
import { setResultOverlay } from "./viewerIntegration.ts"

;(self as any).MonacoEnvironment = {
  getWorkerUrl: (_: string, label: string) => (label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js"),
}

const ts = monaco.languages.typescript
ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true, strict: true })
ts.typescriptDefaults.setEagerModelSync(true)

const DEFAULT_SOURCE = `map.guardians
  .select((g) => [g.id, g.position, map.healingOrbs.closest(g)!.id])
  .toArray()
`

const out = document.getElementById("results")!
const runBtn = document.getElementById("run") as HTMLButtonElement
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement
const status = document.getElementById("status")!

const [lib, bundle] = await Promise.all([
  fetch("library.json").then((r) => r.json() as Promise<LibraryArtifact>),
  fetch("bundle.json").then((r) => r.json())
])
for (const [name, text] of Object.entries(lib.dts)) ts.typescriptDefaults.addExtraLib(text, `file:///library/${name}`)
ts.typescriptDefaults.addExtraLib(globalsShim(lib), "file:///library/globals.d.ts")

const model = monaco.editor.createModel(DEFAULT_SOURCE, "typescript", monaco.Uri.parse("file:///query.ts"))
const editor = monaco.editor.create(document.getElementById("editor")!, { model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false } })

const runner = new SandboxRunner(document, toPrelude(lib.js))
await runner.load(bundle)
const compiler = monacoCompiler(monaco)
const queryEngineLayer = makeQueryEngine({ compiler, runner })

// Standalone layer with mocks for viewer and selection
const standaloneLayer = Layer.mergeAll(queryEngineLayer, MockViewerService, MockSelectionBus)

// Live diagnostics as markers on the visible model (same service the engine uses).
let checkTimer: ReturnType<typeof setTimeout> | undefined
const check = () =>
  Effect.runPromise(Effect.gen(function* () { return yield* (yield* QueryEngine).check(model.getValue()) }).pipe(Effect.provide(queryEngineLayer))).then((ds) =>
    monaco.editor.setModelMarkers(model, "query", ds.map((d) => ({
      message: d.message, startLineNumber: d.line, startColumn: d.column, endLineNumber: d.line, endColumn: d.column + 1,
      severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
    }))))
model.onDidChangeContent(() => { clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 300) })

let currentResult: QueryResult | null = null
let selectedRowIds: Set<string> = new Set()

const renderResultsWithSelection = () => {
  if (currentResult) {
    out.replaceChildren(renderResults(document, currentResult, {
      selectedRows: selectedRowIds,
      onRowSelect: (rowId: string) => {
        selectedRowIds = new Set([rowId])
        renderResultsWithSelection()
      }
    }))
  }
}

const run = async () => {
  runBtn.disabled = true
  cancelBtn.disabled = false
  status.textContent = "running…"
  try {
    const { result } = await runQuery(queryEngineLayer, model.getValue())
    currentResult = result

    // Set overlay on the map viewer
    await Effect.runPromise(
      setResultOverlay("query-result", result).pipe(Effect.provide(standaloneLayer))
    ).catch(() => {
      // Silently fail if viewer is not available (in standalone mode with mocks)
    })

    selectedRowIds = new Set()
    renderResultsWithSelection()
    status.textContent = "done"
  } catch (e) {
    const err = document.createElement("pre")
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
const cancel = () => void Effect.runPromise(Effect.gen(function* () { yield* (yield* QueryEngine).cancel }).pipe(Effect.provide(queryEngineLayer)))
runBtn.addEventListener("click", () => void run())
cancelBtn.addEventListener("click", cancel)
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run())
;(self as any).__qb = { editor, run, cancel }
