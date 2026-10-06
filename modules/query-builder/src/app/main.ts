import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js"
import "monaco-editor/esm/vs/editor/editor.all.js"
import { mockEngineLayer, runQuery } from "./engine.ts"
import { FIXTURE_DTS } from "./fixtureDts.ts"
import { renderResults } from "./resultsTable.ts"

;(self as any).MonacoEnvironment = {
  getWorkerUrl: (_: string, label: string) => (label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js"),
}

const ts = monaco.languages.typescript
ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true, strict: true })
ts.typescriptDefaults.setEagerModelSync(true)
ts.typescriptDefaults.addExtraLib(FIXTURE_DTS, "file:///library.d.ts")

const DEFAULT_SOURCE = "map.spawnsOf(\"yellow\").map((s) => s.position)\n"
const model = monaco.editor.createModel(DEFAULT_SOURCE, "typescript", monaco.Uri.parse("file:///query.ts"))
const editor = monaco.editor.create(document.getElementById("editor")!, { model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false } })

const out = document.getElementById("results")!
const runBtn = document.getElementById("run") as HTMLButtonElement
const status = document.getElementById("status")!

const run = async () => {
  runBtn.disabled = true
  status.textContent = "running…"
  try {
    const { result } = await runQuery(mockEngineLayer, model.getValue())
    out.replaceChildren(renderResults(document, result))
    status.textContent = "done"
  } catch (e) {
    out.textContent = String(e)
    status.textContent = "error"
  } finally {
    runBtn.disabled = false
  }
}
runBtn.addEventListener("click", () => void run())
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run())
;(self as any).__qb = { editor, run }
