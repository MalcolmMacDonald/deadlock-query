import type { SemanticsLike, SpatialInput } from "./spatial.ts"

/** Internal: the active spatial backend (one map per worker). */
let active: SpatialInput | undefined
export const setActiveSpatial = (s: SpatialInput | undefined): void => { active = s }
export const requireSpatial = (what: string): SpatialInput => {
  if (!active) throw new Error(`${what} needs a spatial backend: pass { spatial: { raycaster, semantics } } to MapContext.fromBundle`)
  return active
}
export const requireSemantics = (what: string): { s: SpatialInput; sem: SemanticsLike } => {
  const s = requireSpatial(what)
  if (!s.semantics) throw new Error(`${what} needs semantics (spatial-core semantics/); none were provided`)
  return { s, sem: s.semantics }
}
/** True when results depend on placeholder (non-final) semantics. */
export const isProvisional = (): boolean => active?.semantics?.placeholder === true
