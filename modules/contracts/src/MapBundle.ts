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
  materials: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Level of detail, 0 = full resolution (the default when absent). A LOD tile is a separate entry that shares its
   * base tile's `bounds`; use `lodOf` to find the base. Older bundles only encode this in the id (`<id>#lod<n>`): read
   * it through `tileLod` / `tileBaseId`, which understand both.
   */
  lod: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  /** `id` of the LOD0 tile this simplified tile stands in for. Present only when `lod` > 0. */
  lodOf: Schema.optionalKey(Schema.String)
})
export type Tile = typeof Tile.Type

const LOD_ID = /^(.*)#lod(\d+)$/

/** LOD of a tile: the `lod` field, else the legacy `#lod<n>` id suffix, else 0. */
export const tileLod = (tile: Pick<Tile, "id" | "lod">): number => tile.lod ?? Number(LOD_ID.exec(tile.id)?.[2] ?? 0)

/** `id` of the LOD0 tile this tile belongs to (its own id for LOD0): `lodOf`, else the legacy id prefix. */
export const tileBaseId = (tile: Pick<Tile, "id" | "lodOf">): string => tile.lodOf ?? LOD_ID.exec(tile.id)?.[1] ?? tile.id

/** Tiles at one level of detail (default 0: the full-resolution set a viewer should draw without LOD streaming). */
export const tilesAtLod = (manifest: { readonly tiles: ReadonlyArray<Tile> }, lod = 0): ReadonlyArray<Tile> =>
  manifest.tiles.filter((t) => tileLod(t) === lod)

export const CollisionRef = Schema.Struct({
  file: Schema.String,
  format: Schema.Literals(["glb"]),
  /** Per-file transform (physics GLB carries ~0.0254 scale + axis swap; see S2). */
  glbToWorld: Mat4S,
  /** Names of collision layers (InteractAs tags) present, e.g. solid, playerclip, window. */
  layers: Schema.Array(Schema.String)
})

/** A file under the bundle directory, integrity-checked like a tile. */
export const BakedFile = Schema.Struct({
  file: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String
})
export type BakedFile = typeof BakedFile.Type

/**
 * Baked-data record written by map-extractor `bake`. The binary formats belong to spatial-core (`Raycaster.serialize()`,
 * `SampleGrid.serialize()`, `NavMesh.serialize()`); contracts only fixes where the files are and what they were built from.
 * Every field the stages write is typed; `navmesh` is absent until the navmesh stage has run.
 */
export const BakedBvh = Schema.Struct({
  ...BakedFile.fields,
  triangles: Schema.Number,
  vertices: Schema.Number,
  /** Collision layers (glTF `InteractAs`) left out of the BVH. */
  excludedLayers: Schema.Array(Schema.String),
  /** Collision nodes dropped while building the BVH (no usable triangles). */
  skippedNodes: Schema.Number
})
export type BakedBvh = typeof BakedBvh.Type

export const BakedSampleGrid = Schema.Struct({
  ...BakedFile.fields,
  /** World units per cell. */
  cellSize: Schema.Number,
  nx: Schema.Number,
  ny: Schema.Number,
  /** World xy of the grid's minimum corner. */
  origin: Schema.Tuple([Schema.Finite, Schema.Finite]),
  /** Named channels in file order, e.g. `floorHeight`, `interior`, `wallDistance`. */
  channels: Schema.Array(Schema.String),
  /** Semantics parameters the channels were computed with (spatial-core `SemanticsParams`; open set of numbers). */
  params: Schema.Record(Schema.String, Schema.Finite)
})
export type BakedSampleGrid = typeof BakedSampleGrid.Type

/** Agent used for the navmesh, in Source units. */
export const NavAgent = Schema.Struct({
  radius: Schema.Number, height: Schema.Number, climb: Schema.Number, slopeDegrees: Schema.Number
})

export const BakedNavmesh = Schema.Struct({
  ...BakedFile.fields,
  bakeVersion: Schema.String,
  inputKey: Schema.String,
  polygons: Schema.Number,
  vertices: Schema.Number,
  tiles: Schema.Number,
  /** Border edges split so neighbouring Recast tiles share vertices. */
  stitchedEdges: Schema.Number,
  components: Schema.Number,
  /** Polygons of the largest connected component / all polygons, 0..1. */
  largestComponentShare: Schema.Number,
  links: Schema.Struct({
    count: Schema.Number,
    dropped: Schema.Number,
    byKind: Schema.Record(Schema.String, Schema.Number)
  }),
  agent: NavAgent,
  recast: Schema.Struct({ cellSize: Schema.Number, cellHeight: Schema.Number, tileSize: Schema.Number }),
  excludedLayers: Schema.Array(Schema.String),
  inputTriangles: Schema.Number
})
export type BakedNavmesh = typeof BakedNavmesh.Type

export const Baked = Schema.Struct({
  bakeVersion: Schema.String,
  /** Hash of the spatial-core semantics sources (+ params) the channels were computed with; re-bake when it changes. */
  semanticsVersion: Schema.String,
  /** True while the semantics are unreviewed placeholders: `interior`/`wallDistance` values are provisional. */
  placeholder: Schema.Boolean,
  /** Everything the output depends on; equal key + files present = nothing to do. */
  inputKey: Schema.String,
  bvh: BakedBvh,
  sampleGrid: BakedSampleGrid,
  navmesh: Schema.optionalKey(BakedNavmesh)
})
export type Baked = typeof Baked.Type

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
  baked: Schema.optionalKey(Baked),
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
