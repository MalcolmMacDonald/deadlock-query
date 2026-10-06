import { Effect, Stream } from "effect"
import type { Entity, Manifest } from "@deadlock-query/contracts"
import { ViewerController, inlineDecoder, makeViewerPanel, workerDecoder, type ManifestTile, type WorkerLike } from "../src/index.ts"

/** Streams the synthetic >500 MB map served by `e2e/streaming.ts`; exposes the controller for assertions. */
const manifest = (await (await fetch("/synthetic/manifest.json")).json()) as Manifest
const entities: Entity[] = []
const controller = new ViewerController()
;(globalThis as any).__viewer = controller
;(globalThis as any).__fetched = [] as string[]
;(globalThis as any).__progress = [] as unknown[]
Effect.runFork(Stream.runForEach(controller.progress, (s) => Effect.sync(() => (globalThis as any).__progress.push(s))))
const params = new URLSearchParams(location.search)
const budgetBytes = Number(params.get("budget") ?? 100 * 1024 * 1024)
makeViewerPanel({
  manifest, entities, tiles: new Map(),
  tileSource: async (t: ManifestTile) => {
    ;(globalThis as any).__fetched.push(t.id)
    const res = await fetch(`/synthetic/${t.file}`)
    if (!res.ok) throw new Error(`${t.file}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  },
  // Bun's bundler does not follow `new Worker(new URL(...))`, so the test serves the worker bundle itself.
  streaming: {
    budgetBytes,
    decoder: params.get("workers") === "0" ? inlineDecoder() : workerDecoder(() => new Worker("/tileWorker.js", { type: "module" }) as unknown as WorkerLike, 2)
  }
}, controller).mount(document.getElementById("app")!)
