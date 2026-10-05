import { Effect, Schema } from "effect"

/** Shapes follow the S2 findings in modules/map-extractor/STATE.md (dl_midtown, build 25712201). */
export const SCHEMA_VERSION = "1.0.0"

export const Vec3S = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])
export const AabbS = Schema.Struct({ min: Vec3S, max: Vec3S })
export const Mat4S = Schema.Array(Schema.Finite).check(Schema.isMinLength(16), Schema.isMaxLength(16))

/** Normalised entity kinds the query library uses; unmapped classes keep `kind` undefined. */
export const EntityKind = Schema.Literals([
  "guardian", "walker", "patron", "barracks", "baseSentry", "healingOrb", "creepCamp",
  "zipline", "jumpPad", "climbRope", "interior", "shop", "spawn", "trooperSpawn",
  "capturePoint", "powerup", "crate", "laneMarker"
])
export type EntityKind = typeof EntityKind.Type

export const Entity = Schema.Struct({
  id: Schema.String,
  /** Source entity classname, e.g. `citadel_pickup_spawner`. Unknown classes are preserved. */
  class: Schema.String,
  kind: Schema.optionalKey(EntityKind),
  position: Vec3S,
  /** Euler angles in degrees (pitch, yaw, roll) as in the vents file. */
  rotation: Schema.optionalKey(Vec3S),
  team: Schema.optionalKey(Schema.Number),
  lane: Schema.optionalKey(Schema.Number),
  /** Remaining raw key/values (subclass_name, targetname, pathnodes, ...). */
  properties: Schema.Record(Schema.String, Schema.Unknown)
})
export type Entity = typeof Entity.Type

export const EntitiesFile = Schema.Struct({
  schemaVersion: Schema.String,
  entities: Schema.Array(Entity)
})
export type EntitiesFile = typeof EntitiesFile.Type

export const Tile = Schema.Struct({
  id: Schema.String,
  bounds: AabbS,
  file: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  /** Optional material identity recovered from mesh names (`..._mt_<material>`). */
  materials: Schema.optionalKey(Schema.Array(Schema.String))
})

export const CollisionRef = Schema.Struct({
  file: Schema.String,
  format: Schema.Literals(["glb"]),
  /** Per-file transform (physics GLB carries ~0.0254 scale + axis swap; see S2). */
  glbToWorld: Mat4S,
  /** Names of collision layers (InteractAs tags) present, e.g. solid, playerclip, window. */
  layers: Schema.Array(Schema.String)
})

export const Manifest = Schema.Struct({
  schemaVersion: Schema.String,
  gameBuildId: Schema.String,
  mapName: Schema.String,
  tier: Schema.Literals(["full", "lite"]),
  coordinateSystem: Schema.Struct({
    up: Schema.Literals(["Z"]),
    unit: Schema.Literals(["source"]),
    /** Render-tile transform; collision carries its own in `collision.glbToWorld`. */
    glbToWorld: Mat4S
  }),
  bounds: AabbS,
  tiles: Schema.Array(Tile),
  collision: Schema.optionalKey(CollisionRef),
  entitiesFile: Schema.String,
  baked: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  provenance: Schema.Struct({
    extractorVersion: Schema.String,
    s2vVersion: Schema.String,
    synthetic: Schema.optionalKey(Schema.Boolean)
  })
})
export type Manifest = typeof Manifest.Type

export class UnsupportedSchemaVersion extends Schema.TaggedError<UnsupportedSchemaVersion>()(
  "UnsupportedSchemaVersion",
  { found: Schema.String, supportedMajor: Schema.Number, message: Schema.String }
) {}

/** Decode a versioned document; fails with a message saying which side must update. */
export const decodeVersioned = <S extends Schema.Constraint & { readonly Type: { readonly schemaVersion: string } }>(
  schema: S,
  minMajor: number,
  maxMajor: number = minMajor
) =>
  (input: unknown) =>
    Effect.gen(function* () {
      const v = (input as { schemaVersion?: unknown } | null)?.schemaVersion
      const major = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN
      if (!Number.isFinite(major) || major < minMajor) {
        return yield* new UnsupportedSchemaVersion({
          found: String(v), supportedMajor: maxMajor,
          message: `Document schemaVersion ${String(v)} is older than supported ${minMajor}.x: re-run the extractor.`
        })
      }
      if (major > maxMajor) {
        return yield* new UnsupportedSchemaVersion({
          found: String(v), supportedMajor: maxMajor,
          message: `Document schemaVersion ${String(v)} is newer than supported ${maxMajor}.x: update this app.`
        })
      }
      return yield* Schema.decodeUnknownEffect(schema)(input)
    })
