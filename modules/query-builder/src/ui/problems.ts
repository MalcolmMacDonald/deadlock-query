import type { QueryDiagnostic } from "@deadlock-query/contracts"

export interface ProblemSummary {
  readonly errors: number
  readonly warnings: number
  /** Short label for the toggle button, e.g. "Problems: 1 error, 2 warnings". */
  readonly label: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export const summarizeProblems = (ds: ReadonlyArray<QueryDiagnostic>): ProblemSummary => {
  const errors = ds.filter((d) => d.severity === "error").length
  const warnings = ds.length - errors
  const parts = [...(errors ? [plural(errors, "error")] : []), ...(warnings ? [plural(warnings, "warning")] : [])]
  return { errors, warnings, label: parts.length ? `Problems: ${parts.join(", ")}` : "No problems" }
}

/** Fills `list` with one button per diagnostic (errors first, then by position); activating one jumps to it in the editor. */
export const renderProblems = (doc: Document, list: HTMLElement, ds: ReadonlyArray<QueryDiagnostic>, goTo: (d: QueryDiagnostic) => void): void => {
  list.replaceChildren()
  if (ds.length === 0) {
    const none = doc.createElement("div")
    none.className = "empty"
    none.textContent = "No problems found."
    list.append(none)
    return
  }
  const sorted = [...ds].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.line - b.line || a.column - b.column)
  for (const d of sorted) {
    const b = doc.createElement("button")
    b.type = "button"
    b.className = `problem ${d.severity}`
    b.dataset.testid = "problem"
    b.textContent = `${d.severity === "error" ? "Error" : "Warning"} at line ${d.line}, column ${d.column}: ${d.message}`
    b.addEventListener("click", () => goTo(d))
    list.append(b)
  }
}
