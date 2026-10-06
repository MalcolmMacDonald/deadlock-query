import { Schema } from "effect"
import { SCHEMA_VERSION, Vec3S } from "./MapBundle.ts"

const Id = Schema.String.check(Schema.isMinLength(1))
const Points = (min: number) => Schema.Array(Vec3S).check(Schema.isMinLength(min))

/** Fields shared by every annotation kind. Geometry is world-space Source units (Z-up), like overlays. */
const common = {
  id: Id,
  /** Optional grouping into a `AnnotationLayer`; absent means the default layer of that kind. */
  layer: Schema.optionalKey(Id),
  color: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
}

export const AnnotationKind = Schema.Literals(["point", "label", "polyline", "polygon", "measure"])
export type AnnotationKind = typeof AnnotationKind.Type

export const Annotation = Schema.Union([
  Schema.Struct({ ...common, kind: Schema.Literal("point"), points: Points(1).check(Schema.isMaxLength(1)) }),
  Schema.Struct({ ...common, kind: Schema.Literal("label"), points: Points(1).check(Schema.isMaxLength(1)), text: Schema.String }),
  Schema.Struct({ ...common, kind: Schema.Literal("polyline"), points: Points(2) }),
  Schema.Struct({ ...common, kind: Schema.Literal("polygon"), points: Points(3) }),
  Schema.Struct({ ...common, kind: Schema.Literal("measure"), points: Points(2) })
])
export type Annotation = typeof Annotation.Type

export const AnnotationLayer = Schema.Struct({
  id: Id,
  name: Schema.String,
  visible: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Boolean),
  color: Schema.optionalKey(Schema.String)
})
export type AnnotationLayer = typeof AnnotationLayer.Type

/**
 * Import/export + autosave document of the viewer annotation tools. Ids must be unique and every `layer`
 * reference must resolve; use `validateAnnotationDocument` after decoding for those cross-field rules.
 */
export const AnnotationDocument = Schema.Struct({
  schemaVersion: Schema.String,
  /** Map and build the annotations were drawn on, so a mismatched import can warn. */
  mapName: Schema.optionalKey(Schema.String),
  gameBuildId: Schema.optionalKey(Schema.String),
  layers: Schema.optionalKey(Schema.Array(AnnotationLayer)),
  annotations: Schema.Array(Annotation)
})
export type AnnotationDocument = typeof AnnotationDocument.Type

export const makeAnnotationDocument = (
  annotations: ReadonlyArray<Annotation>,
  extra: Partial<Pick<AnnotationDocument, "mapName" | "gameBuildId" | "layers">> = {}
): AnnotationDocument => ({ schemaVersion: SCHEMA_VERSION, ...extra, annotations })

/** Cross-field rules the schema cannot express: unique annotation/layer ids and resolvable layer references. */
export const validateAnnotationDocument = (doc: AnnotationDocument): ReadonlyArray<string> => {
  const errors: string[] = []
  const layerIds = new Set<string>()
  for (const l of doc.layers ?? []) {
    if (layerIds.has(l.id)) errors.push(`duplicate layer id "${l.id}"`)
    layerIds.add(l.id)
  }
  const ids = new Set<string>()
  for (const a of doc.annotations) {
    if (ids.has(a.id)) errors.push(`duplicate annotation id "${a.id}"`)
    ids.add(a.id)
    if (a.layer !== undefined && !layerIds.has(a.layer)) errors.push(`annotation "${a.id}" references unknown layer "${a.layer}"`)
  }
  return errors
}
