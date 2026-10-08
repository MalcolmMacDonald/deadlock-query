export interface Request {
  readonly from: string
  readonly text: string
  /** Module the request names (`contracts: ...` or `[contracts] ...`), when it names one. */
  readonly target?: string
}

const HEADING = /^#{1,6}\s*Blockers\s*\/\s*Requests/i

/** Requests listed under a module's STATE.md "Blockers / Requests" heading; "(none)" and blanks are skipped. */
export const extractRequests = (stateMd: string, from: string, modules: ReadonlyArray<string> = []): Request[] => {
  const lines = stateMd.split("\n")
  const start = lines.findIndex((l) => HEADING.test(l))
  if (start < 0) return []
  const out: Request[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line)
    if (!m || /^\(?none\)?\.?$/i.test(m[1]!)) continue
    const text = m[1]!
    const named = /^\[?([a-z0-9-]+)\]?\s*[:\]]/i.exec(text)?.[1]?.toLowerCase()
    const target = named !== undefined && modules.includes(named) ? named : undefined
    out.push({ from, text, ...(target ? { target } : {}) })
  }
  return out
}

/** A feature draft for a suggested card; the operator still reviews it before it becomes an issue. */
export const requestDraft = (r: Request) => ({
  title: r.text.length > 80 ? `${r.text.slice(0, 77)}...` : r.text,
  body: `## Description\nRequested by \`${r.from}\` in its STATE.md:\n\n> ${r.text}`,
  labels: r.target ? [`module:${r.target}`] : []
})
