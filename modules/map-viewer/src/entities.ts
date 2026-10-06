import type { Entity, EntityKind, OverlayFeature, OverlayStyle } from "@deadlock-query/contracts"

/** Entity overlay layers all have ids under this prefix (`entities.guardian`, `entities.other`). */
export const ENTITY_LAYER_PREFIX = "entities."
export const OTHER_ENTITIES_LAYER = `${ENTITY_LAYER_PREFIX}other`

export const isEntityLayerId = (id: string): boolean => id.startsWith(ENTITY_LAYER_PREFIX)

interface KindStyle { readonly label: string; readonly color: string; readonly size: number }

const KINDS: Record<EntityKind, KindStyle> = {
  guardian: { label: "Guardians", color: "#e8a33d", size: 16 },
  walker: { label: "Walkers", color: "#d45d5d", size: 16 },
  patron: { label: "Patrons", color: "#b04fd0", size: 18 },
  barracks: { label: "Barracks", color: "#c9785a", size: 14 },
  baseSentry: { label: "Base sentries", color: "#d98a8a", size: 12 },
  healingOrb: { label: "Healing orbs", color: "#7be0a0", size: 10 },
  creepCamp: { label: "Creep camps", color: "#4fb36b", size: 14 },
  zipline: { label: "Ziplines", color: "#5ec4e8", size: 9 },
  jumpPad: { label: "Jump pads", color: "#9fd35f", size: 10 },
  climbRope: { label: "Climb ropes", color: "#b9a46a", size: 9 },
  interior: { label: "Interiors", color: "#8f9bd6", size: 10 },
  shop: { label: "Shops", color: "#f0d24f", size: 14 },
  spawn: { label: "Spawns", color: "#ffffff", size: 12 },
  trooperSpawn: { label: "Trooper spawns", color: "#e8e8a0", size: 10 },
  capturePoint: { label: "Capture points", color: "#ff8fd0", size: 14 },
  powerup: { label: "Powerups", color: "#ffd24f", size: 11 },
  crate: { label: "Crates", color: "#c4a574", size: 10 },
  laneMarker: { label: "Lane markers", color: "#8fa8c4", size: 8 }
}

const OTHER_STYLE: KindStyle = { label: "Other entities", color: "#8a8f98", size: 7 }

/** Kinds that are few and worth a name on the map; the rest would be clutter. */
const LABELLED: ReadonlySet<EntityKind> = new Set(["guardian", "walker", "patron", "barracks", "baseSentry", "shop", "capturePoint", "powerup", "spawn"])

/** One-line description of an entity: kind or class, team and lane when it has them. */
export const describeEntity = (e: Entity): string => {
  const name = e.kind ? KINDS[e.kind].label.replace(/s$/, "") : e.class
  const extra = [e.team !== undefined ? `team ${e.team}` : "", e.lane !== undefined ? `lane ${e.lane}` : ""].filter(Boolean).join(", ")
  return extra ? `${name} (${extra})` : name
}

export interface EntityLayer {
  readonly id: string
  readonly label: string
  readonly style: OverlayStyle
  readonly features: ReadonlyArray<OverlayFeature>
  /** Entity behind each of `features`. */
  readonly entities: ReadonlyArray<Entity>
  /** Layers for things that are not map objects start switched off. */
  readonly hiddenByDefault: boolean
}

/**
 * One overlay layer per entity kind present (in a stable order), plus `entities.other` for entities without a
 * normalised kind (lights, props, soundscapes: thousands on a real map, so that layer starts hidden). Feature ids
 * are `<layerId>:<index>`, indexing `entities`.
 */
export const entityLayers = (entities: ReadonlyArray<Entity>): ReadonlyArray<EntityLayer> => {
  const groups = new Map<string, Entity[]>()
  for (const e of entities) {
    const id = e.kind ? `${ENTITY_LAYER_PREFIX}${e.kind}` : OTHER_ENTITIES_LAYER
    const g = groups.get(id)
    if (g) g.push(e)
    else groups.set(id, [e])
  }
  const order = [...Object.keys(KINDS).map((k) => `${ENTITY_LAYER_PREFIX}${k}`), OTHER_ENTITIES_LAYER]
  const out: EntityLayer[] = []
  for (const id of order) {
    const list = groups.get(id)
    if (!list) continue
    const kind = id === OTHER_ENTITIES_LAYER ? undefined : (id.slice(ENTITY_LAYER_PREFIX.length) as EntityKind)
    const style = kind ? KINDS[kind] : OTHER_STYLE
    const labelled = kind !== undefined && LABELLED.has(kind)
    out.push({
      id,
      label: `${style.label} (${list.length})`,
      style: { color: style.color, size: style.size },
      features: list.map((e): OverlayFeature => (labelled ? { type: "point", at: e.position, label: describeEntity(e) } : { type: "point", at: e.position })),
      entities: list,
      hiddenByDefault: kind === undefined
    })
  }
  return out
}
