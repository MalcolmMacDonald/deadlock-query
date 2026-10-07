const LANE_NAMES: Record<number, string> = { 1: "yellow", 2: "blue", 3: "green" }

/** "healingOrb #27 · blue": the entity's kind (else its class), the part of its id after the colon, and its lane. */
export const entityLabel = (e: unknown, id: string): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const { kind, class: cls, lane } = e as { kind?: unknown; class?: unknown; lane?: unknown }
  const name = typeof kind === "string" ? kind : typeof cls === "string" ? cls : undefined
  if (name === undefined) return undefined
  const laneName = typeof lane === "number" ? LANE_NAMES[lane] : undefined
  return `${name} #${id.slice(id.lastIndexOf(":") + 1)}${laneName ? ` · ${laneName}` : ""}`
}
