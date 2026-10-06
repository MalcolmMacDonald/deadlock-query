/** What a query needs from the loaded map bundle; the gallery says so up front instead of failing at run time. */
export type Requirement = "nav" | "spatial" | "semantics"

export interface GalleryQuery {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly source: string
  readonly requires: ReadonlyArray<Requirement>
  /** Shown on the card while the data this query needs is unfinished (e.g. placeholder semantics). */
  readonly note?: string
}

const NAV_PENDING = "Needs the baked navmesh. Walkable data for the real map is still pending in the map extractor, so on a bundle without navigation the run stops with a \"needs map data\" message."

/** The three PLAN.md headline queries, plus a starter that already runs on the fixture map. */
export const GALLERY: ReadonlyArray<GalleryQuery> = [
  {
    id: "guardian-nearest-orb",
    title: "Starter: nearest healing orb to each guardian",
    description: "A first query: one row per guardian with its position and the closest healing orb. Runs on any bundle.",
    source: `map.guardians
  .select((g) => {
    const orb = map.healingOrbs.closest(g)!
    return [g.id, g.position, orb.id, Math.round(g.distanceTo(orb))]
  })
  .toArray()
`,
    requires: [],
  },
  {
    id: "orbs-within-10s",
    title: "Healing orbs within 10 seconds of a lane's guardian",
    description: "Travel time over the navmesh from a yellow-lane guardian (hero speed 7 m/s, ziplines 15 m/s). Change the lane or the number of seconds.",
    source: `map.healingOrbs
  .withinTravelTime(seconds(10), map.guardians.inLane("yellow"))
  .select((o) => o.id)
  .toArray()
`,
    requires: ["nav"],
    note: NAV_PENDING,
  },
  {
    id: "wall-detour-pairs",
    title: "Wall positions twice as far to walk as to fly",
    description: "Pairs of wall points whose walking distance is at least double the straight line. Samples a bounded set first because pairs grow quadratically.",
    source: `map.sample.walls(600)
  .take(300)
  .pairs()
  .where(([a, b]) => a.travelDistanceTo(b) >= 2 * a.crowFliesTo(b))
  .select(([a, b]) => [a.toArray(), b.toArray()])
  .toArray()
`,
    requires: ["nav", "semantics"],
    note: `${NAV_PENDING} Wall points also use the owner's placeholder semantics, so results are provisional.`,
  },
  {
    id: "camps-visible-from-high-ground",
    title: "Neutral camps visible from high ground",
    description: "Creep camps with line of sight from any floor point at least 800 units above the map's lowest point.",
    source: `map.creepCamps
  .visibleFrom(map.sample.grid(400).where((p) => p.height() >= 800))
  .select((c) => c.id)
  .toArray()
`,
    requires: ["spatial", "semantics"],
    note: "Visibility and height come from the owner's semantics, which are placeholders for now: results are provisional.",
  },
]
