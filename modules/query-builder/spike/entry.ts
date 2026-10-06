import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js"
import "monaco-editor/esm/vs/editor/editor.all.js"
import { SandboxRunner } from "../src/sandbox/runner.ts"
import { FIXTURE_DTS, FIXTURE_RUNTIME } from "./fixture.ts"

;(self as any).MonacoEnvironment = {
  getWorkerUrl: (_: string, label: string) => (label === "typescript" || label === "javascript" ? "ts.worker.js" : "editor.worker.js"),
}

const ts = monaco.languages.typescript
ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true, strict: true, noEmit: false })
ts.typescriptDefaults.setEagerModelSync(true)
ts.typescriptDefaults.addExtraLib(FIXTURE_DTS, "file:///library.d.ts")

const openedAt = performance.now()
const model = monaco.editor.createModel("", "typescript", monaco.Uri.parse("file:///query.ts"))
const editor = monaco.editor.create(document.getElementById("ed")!, { model, automaticLayout: true, theme: "vs-dark" })
editor.focus()

const runner = new SandboxRunner(document, FIXTURE_RUNTIME)

const emit = async (): Promise<{ js: string; errors: number }> => {
  const w = await ts.getTypeScriptWorker()
  const svc = await w(model.uri)
  const uri = model.uri.toString()
  const out = await svc.getEmitOutput(uri)
  const diags = [...(await svc.getSyntacticDiagnostics(uri)), ...(await svc.getSemanticDiagnostics(uri))]
  return { js: out.outputFiles[0]?.text ?? "", errors: diags.length }
}

;(self as any).__spike = {
  openedAt,
  editor,
  emit,
  ready: () => runner.ready(),
  run: async (source: string, timeoutMs?: number) => {
    model.setValue(source)
    const { js, errors } = await emit()
    const t0 = performance.now()
    const outcome = await runner.run(js, timeoutMs ? { timeoutMs } : {})
    return { outcome, errors, js, totalMs: performance.now() - t0 }
  },
  /** Cancel a run in progress; returns ms until a replacement worker is ready. */
  cancel: async () => { const t0 = performance.now(); await runner.cancel(); return performance.now() - t0 },
  startRun: (source: string) => { model.setValue(source); return emit().then(({ js }) => { void runner.run(js) }) },
}
