import type { MapContext } from "../src/index.ts"

/**
 * For every creep camp, the healing orb with the shortest walking time to it (`orb` is null when no orb is reachable).
 * @requires nav
 * @example camp-nearest-orb
 * @category Examples
 */
export default (map: MapContext) => {
  const fields = map.healingOrbs.select((o) => ({ id: o.id, time: map.nav.timeFrom(o.position) })).toArray()
  return map.creepCamps
    .select((c) => {
      let best: { id: string; s: number } | null = null
      for (const f of fields) {
        const s = f.time(c.position)
        if (Number.isFinite(s) && (!best || s < best.s)) best = { id: f.id, s }
      }
      return { camp: c.id, orb: best ? best.id : null, seconds: best ? Math.round(best.s * 10) / 10 : null }
    })
    .toArray()
}
