/** Snippet completions for the query shapes people write most. Monaco snippet syntax (`${1:default}`). */
export interface QuerySnippet {
  readonly label: string
  readonly detail: string
  readonly body: string
  /** Whole statements start a query; chain snippets continue an existing expression (`.select(…)`). */
  readonly kind: "statement" | "chain"
}

export const SNIPPETS: ReadonlyArray<QuerySnippet> = [
  {
    label: "guardianNearestOrb",
    detail: "One row per guardian with its closest healing orb",
    kind: "statement",
    body: `map.guardians
  .select((\${1:g}) => [\${1:g}.id, \${1:g}.position, map.healingOrbs.closest(\${1:g})!.id])
  .toArray()`,
  },
  {
    label: "withinTravelTime",
    detail: "Entities within N seconds of travel from others",
    kind: "statement",
    body: `map.healingOrbs
  .withinTravelTime(seconds(\${1:10}), map.guardians.inLane(\${2:"yellow"}))
  .select((o) => o.id)
  .toArray()`,
  },
  {
    label: "withinDistance",
    detail: "Entities within a straight-line distance of others",
    kind: "statement",
    body: `map.healingOrbs
  .within(meters(\${1:40}), map.guardians.inLane(\${2:"yellow"}))
  .select((o) => o.id)
  .toArray()`,
  },
  {
    label: "walkVersusFly",
    detail: "Wall pairs far apart by walking, close as the crow flies",
    kind: "statement",
    body: `map.sample.walls(\${1:600})
  .take(\${2:300})
  .pairs()
  .where(([a, b]) => a.travelDistanceTo(b) >= \${3:2} * a.crowFliesTo(b))
  .select(([a, b]) => [a.toArray(), b.toArray()])
  .toArray()`,
  },
  {
    label: "visibleFromHighGround",
    detail: "Camps (or other entities) visible from high floor points",
    kind: "statement",
    body: `map.creepCamps
  .visibleFrom(map.sample.grid(\${1:400}).where((p) => p.height() >= \${2:800}))
  .select((c) => c.id)
  .toArray()`,
  },
  {
    label: "selectRow",
    detail: "Project each item to [id, position]",
    kind: "chain",
    body: `.select((\${1:e}) => [\${1:e}.id, \${1:e}.position])`,
  },
  {
    label: "pairsWhereClose",
    detail: "Pairs of items closer than a distance",
    kind: "chain",
    body: `.pairs().where(([\${1:a}, \${2:b}]) => \${1:a}.distanceTo(\${2:b}) < \${3:meters(50)})`,
  },
  {
    label: "orderByDistance",
    detail: "Sort by distance to a point or entity",
    kind: "chain",
    body: `.orderBy((\${1:e}) => \${1:e}.distanceTo(\${2:map.guardians.first()!}))`,
  },
]

/** The snippet with every placeholder replaced by its default text (what you get if you accept all defaults). */
export const expandSnippet = (body: string): string =>
  body.replace(/\$\{\d+:((?:[^}\\]|\\.)*)\}/g, "$1").replace(/\$\{\d+\}|\$\d+/g, "")
