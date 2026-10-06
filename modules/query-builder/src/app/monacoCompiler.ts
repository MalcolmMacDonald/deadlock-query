import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import type { QueryDiagnostic } from "@deadlock-query/contracts"
import type { Compiler } from "../engine/engine.ts"

const flatten = (m: string | { messageText: string; next?: unknown[] }): string =>
  typeof m === "string" ? m : [m.messageText, ...((m.next as Array<typeof m> | undefined) ?? []).map(flatten)].join("\n")

/**
 * Compiler backed by Monaco's TS worker: diagnostics and `getEmitOutput` come from the same
 * language service (and the same library `.d.ts`) that powers completions, so what the editor
 * shows is what runs. Uses a private model so the visible editor is never touched.
 */
export const monacoCompiler = (monaco: typeof Monaco): Compiler => {
  const uri = monaco.Uri.parse("file:///engine/query.ts")
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel("", "typescript", uri)
  return {
    compile: async (source) => {
      model.setValue(source)
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
      const svc = await getWorker(uri)
      const [syntactic, semantic, emit] = await Promise.all([
        svc.getSyntacticDiagnostics(uri.toString()),
        svc.getSemanticDiagnostics(uri.toString()),
        svc.getEmitOutput(uri.toString())
      ])
      const diagnostics: QueryDiagnostic[] = [...syntactic, ...semantic].map((d) => {
        const p = model.getPositionAt(d.start ?? 0)
        return { message: flatten(d.messageText as never), line: p.lineNumber, column: p.column, severity: d.category === 1 ? "error" : "warning" }
      })
      const js = emit.outputFiles.find((f: { name: string }) => f.name.endsWith(".js"))?.text ?? ""
      return { js, diagnostics }
    }
  }
}
