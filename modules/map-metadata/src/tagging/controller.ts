import { Effect } from "effect"
import type { MetadataRecord, OverlayFeature, Vec3 } from "@deadlock-query/contracts"
import type { DraftStore } from "../editor/drafts.ts"
import type { ViewerServiceShape } from "../editor/controller.ts"
import { TAGS, type TagDefinition } from "./tags.ts"

/** An entity the contributor can tag: its id from the loaded map, where it stands and (for display) what it is. */
export interface TaggableEntity {
  readonly id: string
  readonly position: Vec3
  readonly label?: string
}

/** Where the current selection comes from: clicks or a box on the map, or the rows of a query result. */
export interface TagSource {
  readonly selected: () => ReadonlyArray<TaggableEntity>
  readonly subscribe: (fn: () => void) => () => void
}

export interface TagRow {
  readonly tag: TagDefinition
  /** Entities carrying the tag in your drafts. */
  readonly total: number
  /** How many of the selected entities carry it: `0`, some, or all of `selected`. */
  readonly onSelected: number
}

export interface TagState {
  readonly selected: ReadonlyArray<TaggableEntity>
  readonly rows: ReadonlyArray<TagRow>
}

export interface TagController {
  readonly state: () => TagState
  readonly subscribe: (fn: (s: TagState) => void) => () => void
  /** Tags every selected entity (it is a no-op for those that already have it). */
  readonly apply: (tagId: string) => void
  /** Removes the tag from every selected entity. */
  readonly remove: (tagId: string) => void
  /** Adds the tag unless all selected entities already have it, in which case removes it: one button per tag. */
  readonly toggle: (tagId: string) => void
  /** Removes the tag from every entity. */
  readonly clearTag: (tagId: string) => void
  readonly dispose: () => void
}

export interface TagControllerOptions {
  readonly viewer: ViewerServiceShape
  readonly drafts: DraftStore
  readonly source: TagSource
  readonly tags?: ReadonlyArray<TagDefinition>
}

/** Record id for one (tag, entity) pair, so tagging twice is the same record. */
export const tagRecordId = (tagId: string, entityId: string): string =>
  `tag.${tagId}.${entityId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)

const layerOf = (tagId: string) => `metadata.tags.${tagId}`

/** The record of one tagged entity: a `custom` point whose label is the tag id and whose `entityId` property names the entity. */
export const tagRecord = (tagId: string, e: TaggableEntity): MetadataRecord => ({
  id: tagRecordId(tagId, e.id), status: "proposed", provenance: {}, kind: "custom",
  label: tagId, geometry: { type: "point", at: e.position },
  properties: { entityId: e.id.slice(0, 200) }
})

/** The tag a record carries (`undefined` for any other record), and the entity it is on. */
export const tagOf = (r: MetadataRecord, tags: ReadonlyArray<TagDefinition> = TAGS): { readonly tag: TagDefinition; readonly entityId: string } | undefined => {
  if (r.kind !== "custom" || r.geometry.type !== "point") return undefined
  const tag = tags.find((t) => t.id === r.label)
  const entityId = r.properties?.entityId
  return tag && typeof entityId === "string" ? { tag, entityId } : undefined
}

/**
 * Tagging without any DOM: bulk-applies tags to the selected entities, keeps the result in the draft store (so it is
 * saved, validated and submitted like any draft) and draws each tag as its own coloured overlay layer, so tagged state is
 * visible on the map and can be toggled in the Layers panel.
 */
export const createTagController = ({ viewer, drafts, source, tags = TAGS }: TagControllerOptions): TagController => {
  const run = (e: Effect.Effect<unknown>) => void Effect.runFork(e)
  const listeners = new Set<(s: TagState) => void>()
  let snapshot: TagState

  const tagged = (tagId: string) => drafts.list().filter((r) => tagOf(r, tags)?.tag.id === tagId)

  const compute = (): TagState => {
    const selected = source.selected()
    const rows = tags.map((tag) => {
      const have = new Set(tagged(tag.id).map((r) => r.id))
      return { tag, total: have.size, onSelected: selected.filter((e) => have.has(tagRecordId(tag.id, e.id))).length }
    })
    return { selected, rows }
  }

  const draw = () => {
    for (const tag of tags) {
      const of = tagged(tag.id)
      if (of.length === 0) { run(viewer.removeOverlay(layerOf(tag.id))); continue }
      const features = of.flatMap((r): OverlayFeature[] => {
        const t = tagOf(r, tags)
        return t && r.kind === "custom" && r.geometry.type === "point" ? [{ type: "point", at: r.geometry.at, label: tag.label, properties: { tag: tag.id, entityId: t.entityId } }] : []
      })
      run(viewer.setOverlay(layerOf(tag.id), features, { color: tag.color, size: 14 }))
    }
  }

  const update = () => { snapshot = compute(); draw(); for (const fn of listeners) fn(snapshot) }
  const offDrafts = drafts.subscribe(update)
  const offSource = source.subscribe(() => { snapshot = compute(); for (const fn of listeners) fn(snapshot) })
  snapshot = compute()
  draw()

  const known = (id: string) => tags.some((t) => t.id === id)
  const apply = (id: string) => {
    if (!known(id)) return
    for (const e of source.selected()) if (!drafts.get(tagRecordId(id, e.id))) drafts.add(tagRecord(id, e))
  }
  const remove = (id: string) => { for (const e of source.selected()) drafts.remove(tagRecordId(id, e.id)) }

  return {
    state: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => void listeners.delete(fn) },
    apply, remove,
    toggle: (id) => {
      const sel = source.selected()
      const all = sel.length > 0 && sel.every((e) => drafts.get(tagRecordId(id, e.id)) !== undefined)
      if (all) remove(id); else apply(id)
    },
    clearTag: (id) => { for (const r of tagged(id)) drafts.remove(r.id) },
    dispose: () => { offDrafts(); offSource(); for (const t of tags) run(viewer.removeOverlay(layerOf(t.id))); listeners.clear() }
  }
}
