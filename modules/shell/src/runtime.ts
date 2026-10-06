import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import { viewerServiceLayer } from "./viewer.ts"
import { MockDevAuth, MockSelectionBus, MockViewerService } from "@deadlock-query/contracts"
import { appDevAuthLayer } from "./devAuth.ts"

export type AnyModule = ModuleDefinition<any>

export interface ModuleFailure {
  readonly moduleId: string
  readonly message: string
}

export interface Composition {
  /** One runtime built from every healthy module Layer (plus the base services). */
  readonly runtime: ManagedRuntime.ManagedRuntime<any, never>
  readonly healthy: ReadonlyArray<AnyModule>
  readonly failed: ReadonlyArray<ModuleFailure>
}

/** Services every module may require; swapped for real layers as modules ship them. */
export const baseLayer = Layer.mergeAll(MockSelectionBus, MockViewerService, MockDevAuth)

/** The app's base: the real `ViewerService` (shared controller with the Map panel) and `DevAuth` (dev site session), mocks elsewhere. */
export const appBaseLayer = Layer.mergeAll(MockSelectionBus, viewerServiceLayer, appDevAuthLayer)

const describe = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause).split("\n")[0] ?? "Layer failed"

/**
 * Builds each module Layer in isolation (sharing one MemoMap so services stay shared), then
 * composes the healthy ones into a single ManagedRuntime. A module whose Layer fails or dies is
 * reported in `failed` and never takes the app down.
 */
export const composeModules = async (
  modules: ReadonlyArray<AnyModule>,
  base: Layer.Layer<any, never, never> = baseLayer,
): Promise<Composition> => {
  const memoMap = Layer.makeMemoMapUnsafe()
  const scope = Scope.makeUnsafe()
  const healthy: Array<AnyModule> = []
  const failed: Array<ModuleFailure> = []
  for (const m of modules) {
    const provided = Layer.provide(m.layer as Layer.Layer<never, never, any>, base)
    const exit = await Effect.runPromiseExit(Layer.buildWithMemoMap(provided, memoMap, scope))
    if (Exit.isSuccess(exit)) healthy.push(m)
    else failed.push({ moduleId: m.id, message: describe(exit.cause) })
  }
  const layer = Layer.mergeAll(
    base,
    ...healthy.map((m) => Layer.provide(m.layer as Layer.Layer<never, never, any>, base)),
  ) as Layer.Layer<any, never, never>
  const runtime = ManagedRuntime.make(layer, { memoMap })
  await runtime.runPromise(Effect.void)
  return { runtime, healthy, failed }
}
