import { Context, Effect, Layer, Stream } from "effect"
import type { Entity, Manifest } from "./MapBundle.ts"
import type { QueryResult } from "./QueryResult.ts"
import type { Vec3 } from "./Space.ts"

export class SelectionBus extends Context.Service<
  SelectionBus,
  {
    readonly select: (ids: ReadonlyArray<string>) => Effect.Effect<void>
    readonly current: Effect.Effect<ReadonlyArray<string>>
  }
>()("@deadlock-query/SelectionBus") {}

export interface OverlayStyle {
  readonly color?: string
  readonly size?: number
}

/** Geometry in canonical world space (Source units, Z-up). */
export type OverlayFeature =
  | { readonly type: "point"; readonly at: Vec3; readonly label?: string }
  | { readonly type: "segment" | "polyline"; readonly points: ReadonlyArray<Vec3>; readonly label?: string }
  | { readonly type: "polygon"; readonly ring: ReadonlyArray<Vec3>; readonly label?: string }

export type ViewerEvent =
  | { readonly _tag: "pick"; readonly id: string }
  | { readonly _tag: "hover"; readonly id: string | null }
  | { readonly _tag: "camera"; readonly position: Vec3; readonly target: Vec3 }

export class MapDataError extends Error {
  readonly _tag = "MapDataError"
}

export class MapDataService extends Context.Service<
  MapDataService,
  {
    readonly manifest: Effect.Effect<Manifest, MapDataError>
    readonly entities: Effect.Effect<ReadonlyArray<Entity>, MapDataError>
    readonly loadTile: (tileId: string) => Effect.Effect<Uint8Array, MapDataError>
    readonly collisionBytes: Effect.Effect<Uint8Array, MapDataError>
  }
>()("@deadlock-query/MapDataService") {}

export type QueryProgress = { readonly _tag: "progress"; readonly message: string; readonly fraction?: number }
export type QueryOutput = QueryProgress | { readonly _tag: "result"; readonly result: QueryResult }

export interface QueryDiagnostic {
  readonly message: string
  readonly line: number
  readonly column: number
  readonly severity: "error" | "warning"
}

export class QueryEngine extends Context.Service<
  QueryEngine,
  {
    readonly status: Effect.Effect<"idle" | "compiling" | "running">
    readonly check: (source: string) => Effect.Effect<ReadonlyArray<QueryDiagnostic>>
    readonly run: (source: string, opts?: { readonly timeoutMs?: number }) => Stream.Stream<QueryOutput, Error>
    readonly cancel: Effect.Effect<void>
  }
>()("@deadlock-query/QueryEngine") {}

export class ViewerService extends Context.Service<
  ViewerService,
  {
    readonly loadBundle: (manifestUrl: string) => Effect.Effect<void, Error>
    readonly getCamera: Effect.Effect<{ readonly position: Vec3; readonly target: Vec3 }>
    readonly setCamera: (position: Vec3, target: Vec3) => Effect.Effect<void>
    readonly flyTo: (target: Vec3, distance?: number) => Effect.Effect<void>
    readonly setOverlay: (
      layerId: string, features: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, style?: OverlayStyle
    ) => Effect.Effect<void>
    readonly events: Stream.Stream<ViewerEvent>
    readonly captureImage: Effect.Effect<Uint8Array, Error>
    readonly removeOverlay: (layerId: string) => Effect.Effect<void>
    readonly highlight: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  }
>()("@deadlock-query/ViewerService") {}

export class DevAuth extends Context.Service<
  DevAuth,
  {
    readonly status: Effect.Effect<"anonymous" | "authenticated">
    readonly login: (password: string) => Effect.Effect<boolean>
  }
>()("@deadlock-query/DevAuth") {}

export const MockSelectionBus = Layer.sync(SelectionBus)(() => {
  let ids: ReadonlyArray<string> = []
  return {
    select: (next) => Effect.sync(() => void (ids = next)),
    current: Effect.sync(() => ids)
  }
})

export const MockViewerService = Layer.succeed(ViewerService)({
  loadBundle: () => Effect.void,
  getCamera: Effect.succeed({ position: [0, 0, 0] as Vec3, target: [0, 0, 0] as Vec3 }),
  setCamera: () => Effect.void,
  events: Stream.empty,
  captureImage: Effect.succeed(new Uint8Array()),
  flyTo: () => Effect.void,
  setOverlay: () => Effect.void,
  removeOverlay: () => Effect.void,
  highlight: () => Effect.void
})

export const MockDevAuth = Layer.succeed(DevAuth)({
  status: Effect.succeed("authenticated"),
  login: () => Effect.succeed(true)
})
