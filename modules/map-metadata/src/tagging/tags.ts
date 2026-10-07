/** One thing a contributor can say about an entity. The vocabulary is data: add a row here and every panel offers it. */
export interface TagDefinition {
  /** Stable id, stored as the `label` of the record (`custom` kind), so keep it short and never rename it. */
  readonly id: string
  readonly label: string
  /** Overlay colour of tagged entities on the map. */
  readonly color: string
  readonly hint: string
}

export const TAGS: ReadonlyArray<TagDefinition> = [
  { id: "labelling-box", label: "Labelling box", color: "#4fc3f7", hint: "A box that only labels or names a place" },
  { id: "heavy-box", label: "Heavy box", color: "#ff8a50", hint: "A heavy collision box that blocks movement" },
  { id: "sinners-entity", label: "Sinner's entity", color: "#c77dff", hint: "Part of the Sinner's Sacrifice" }
]

export const tagById = (id: string, tags: ReadonlyArray<TagDefinition> = TAGS): TagDefinition | undefined => tags.find((t) => t.id === id)
