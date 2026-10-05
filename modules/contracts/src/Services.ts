import { Context, Effect, Layer } from "effect"
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

export class ViewerService extends Context.Service<
  ViewerService,
  {
    readonly flyTo: (target: Vec3, distance?: number) => Effect.Effect<void>
    readonly setOverlay: (layerId: string, points: ReadonlyArray<Vec3>, style?: OverlayStyle) => Effect.Effect<void>
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
  flyTo: () => Effect.void,
  setOverlay: () => Effect.void,
  removeOverlay: () => Effect.void,
  highlight: () => Effect.void
})

export const MockDevAuth = Layer.succeed(DevAuth)({
  status: Effect.succeed("authenticated"),
  login: () => Effect.succeed(true)
})
