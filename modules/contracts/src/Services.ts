import { Context, Effect, Layer, Stream } from "effect"
import type { Entity, Manifest } from "./MapBundle.ts"
import type { QueryResult } from "./QueryResult.ts"
import type { Annotation } from "./Annotation.ts"
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

/**
 * Geometry in canonical world space (Source units, Z-up). `properties` is free-form metadata the viewer's inspector
 * lists when the feature is selected, e.g. the other columns of the query-result row the feature came from.
 */
export type OverlayFeature =
  | { readonly type: "point"; readonly at: Vec3; readonly label?: string; readonly properties?: Readonly<Record<string, unknown>> }
  | { readonly type: "segment" | "polyline"; readonly points: ReadonlyArray<Vec3>; readonly label?: string; readonly properties?: Readonly<Record<string, unknown>> }
  | { readonly type: "polygon"; readonly ring: ReadonlyArray<Vec3>; readonly label?: string; readonly properties?: Readonly<Record<string, unknown>> }

/** An annotation as a tool creates it: the viewer assigns the `id`. */
export type NewAnnotation = Annotation extends infer A ? (A extends unknown ? Omit<A, "id"> : never) : never

/** What the viewer hands a registered tool: the only ways it can change the viewer. */
export interface ToolContext {
  /** Adds an annotation (into the active layer) as one undo step. */
  readonly commit: (a: NewAnnotation) => Annotation
  /** Preview geometry drawn while the tool works; replaces the previous preview, `[]` clears it. */
  readonly setDraft: (features: ReadonlyArray<OverlayFeature>) => void
  /** One-line message shown in the Tools panel next to the tool's hint (`undefined` clears it). */
  readonly setStatus: (text: string | undefined) => void
  /** The tool is finished: go back to the Select tool. */
  readonly done: () => void
}

/**
 * A tool contributed by another module (map-metadata, screenshot markers, ...). The viewer feeds it snapped
 * world-space points exactly like a built-in drawing tool and it changes the viewer only through `ToolContext`.
 */
export interface ExternalTool {
  /** Unique, and not one of the viewer's built-in tool ids. */
  readonly id: string
  readonly label: string
  readonly hint?: string
  /** The tool became the active one. */
  readonly activate?: (ctx: ToolContext) => void
  /** The tool stopped being the active one (another tool picked, unregistered); clear any state here. */
  readonly deactivate?: () => void
  /** A click (not a drag) on the map, with the snapped world point. */
  readonly click?: (p: Vec3) => void
  /** Pointer hover with no button down. */
  readonly move?: (p: Vec3) => void
  /** Enter / double-click / the panel's Finish button. */
  readonly finish?: () => void
  /** Escape. */
  readonly cancel?: () => void
}

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
    /**
     * Adds a tool to the viewer's Tools panel; the effect's value unregisters it. Fails (defect) on a duplicate or
     * built-in id.
     */
    readonly registerTool: (tool: ExternalTool) => Effect.Effect<() => void>
    /** Makes the tool with this id (built-in or registered) the active viewer tool; fails (defect) on an unknown id. */
    readonly activateTool?: (id: string) => Effect.Effect<void>
    /** Returns the viewer to its default tool. */
    readonly deactivateTool?: () => Effect.Effect<void>
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

const mockViewerService: (typeof ViewerService)["Service"] = {
  loadBundle: () => Effect.void,
  getCamera: Effect.succeed({ position: [0, 0, 0] as Vec3, target: [0, 0, 0] as Vec3 }),
  setCamera: () => Effect.void,
  events: Stream.empty,
  captureImage: Effect.succeed(new Uint8Array()),
  flyTo: () => Effect.void,
  setOverlay: () => Effect.void,
  removeOverlay: () => Effect.void,
  highlight: () => Effect.void,
  registerTool: () => Effect.succeed(() => {}),
  activateTool: () => Effect.void,
  deactivateTool: () => Effect.void
}

export const MockViewerService = Layer.succeed(ViewerService)(mockViewerService)

/**
 * `MockViewerService` with a `registerTool` that records the tools (visible through `registeredTools`) and rejects a
 * duplicate id like the real viewer; for modules that contribute tools (map-metadata, screenshots).
 */
export const makeMockViewerServiceWithTools = () => {
  const tools = new Map<string, ExternalTool>()
  let active: string | undefined
  const layer = Layer.succeed(ViewerService)({
    ...mockViewerService,
    registerTool: (tool: ExternalTool) => Effect.sync(() => {
      if (tools.has(tool.id)) throw new Error(`tool "${tool.id}" is already registered`)
      tools.set(tool.id, tool)
      return () => { if (tools.get(tool.id) === tool) tools.delete(tool.id) }
    }),
    activateTool: (id: string) => Effect.sync(() => { active = id }),
    deactivateTool: () => Effect.sync(() => { active = undefined })
  })
  return { layer, registeredTools: (): ReadonlyArray<ExternalTool> => [...tools.values()], activeTool: (): string | undefined => active }
}

export const MockDevAuth = Layer.succeed(DevAuth)({
  status: Effect.succeed("authenticated"),
  login: () => Effect.succeed(true)
})
