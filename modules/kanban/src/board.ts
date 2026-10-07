import type { Issue } from "./github.ts"

export const COLUMNS = ["Backlog", "In Progress", "Review", "Done", "Reverted"] as const
export type Column = (typeof COLUMNS)[number]

export const columnOf = (i: Issue): Column => {
  if (i.labels.includes("reverted")) return "Reverted"
  if (i.state === "closed" || i.pr?.merged) return "Done"
  if (i.pr) return "Review"
  if (i.labels.includes("claude")) return "In Progress"
  return "Backlog"
}

export const moduleOf = (i: Issue): string | undefined => {
  const m = i.labels.filter((l) => l.startsWith("module:"))
  return m.length === 1 ? m[0]!.slice("module:".length) : undefined
}

export const groupByColumn = (issues: ReadonlyArray<Issue>, module: string): Record<Column, Issue[]> => {
  const out = Object.fromEntries(COLUMNS.map((c) => [c, [] as Issue[]])) as Record<Column, Issue[]>
  for (const i of issues) if (moduleOf(i) === module) out[columnOf(i)].push(i)
  return out
}
