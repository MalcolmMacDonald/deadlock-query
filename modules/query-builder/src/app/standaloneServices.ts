import { Effect, Stream } from "effect"
import type { OverlayFeature, ViewerEvent, Vec3 } from "@deadlock-query/contracts"
import type { SelectionBusShape, ViewerServiceShape } from "../panel/QueryEditorPanel.ts"

/** Async channel backing a fake viewer's `events` stream. */
const channel = <A>() => {
  const buffer: A[] = []
  let wake: (() => void) | undefined
  return {
    push: (a: A) => { buffer.push(a); wake?.() },
    iterable: (async function* () {
      for (;;) {
        while (buffer.length) yield buffer.shift()!
        await new Promise<void>((r) => { wake = r })
      }
    })() as AsyncIterable<A>
  }
}

/**
 * Standalone host services: a recording viewer (overlay/highlight calls, `emitPick`) and an in-memory
 * selection bus. Stand-ins for the shell's real services; also what the Chromium e2e drives.
 */
export const makeStandaloneServices = () => {
  const events = channel<ViewerEvent>()
  const log = { overlays: new Map<string, ReadonlyArray<OverlayFeature>>(), highlights: [] as Array<ReadonlyArray<string>> }
  let selected: ReadonlyArray<string> = []
  const viewer: ViewerServiceShape = {
    loadBundle: () => Effect.void,
    getCamera: Effect.succeed({ position: [0, 0, 0] as Vec3, target: [0, 0, 0] as Vec3 }),
    setCamera: () => Effect.void,
    flyTo: () => Effect.void,
    setOverlay: (layerId, features) => Effect.sync(() => void log.overlays.set(layerId, features as ReadonlyArray<OverlayFeature>)),
    removeOverlay: (layerId) => Effect.sync(() => void log.overlays.delete(layerId)),
    highlight: (ids) => Effect.sync(() => void log.highlights.push(ids)),
    events: Stream.fromAsyncIterable(events.iterable, (e) => new Error(String(e))).pipe(Stream.orDie),
    captureImage: Effect.succeed(new Uint8Array())
  }
  const selection: SelectionBusShape = {
    select: (ids) => Effect.sync(() => void (selected = ids)),
    current: Effect.sync(() => selected)
  }
  return { viewer, selection, log, emitPick: (id: string) => events.push({ _tag: "pick", id }), setSelected: (ids: ReadonlyArray<string>) => { selected = ids } }
}
