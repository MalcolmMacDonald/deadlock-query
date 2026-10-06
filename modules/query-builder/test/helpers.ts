import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { buildMiniMap } from "@deadlock-query/contracts"
import type { Compiler, Runner } from "../src/engine/engine.ts"
import { toPrelude } from "../src/engine/library.ts"
import type { RunOutcome } from "../src/sandbox/runner.ts"
import { workerSource } from "../src/sandbox/worker-source.ts"

/** Builds the library runtime straight from source into a private temp dir (race-free vs. `dist/`). */
export const buildLibraryJs = async (): Promise<string> => {
  const outdir = mkdtempSync(join(tmpdir(), "dlq-lib-"))
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "../../query-library/src/index.ts")], outdir, target: "browser", format: "esm" })
  if (!r.success) throw new Error(r.logs.join("\n"))
  return await Bun.file(join(outdir, "index.js")).text()
}

export const miniBundle = () => {
  const m = buildMiniMap()
  return { manifest: { mapName: m.manifest.mapName, gameBuildId: m.manifest.gameBuildId }, entities: m.entities }
}

/** No type-check: strips types only. Real diagnostics are covered by the Chromium e2e test. */
export const stripTypesCompiler: Compiler = {
  compile: async (source) => {
    try {
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
      return { js, diagnostics: [] }
    } catch (e) {
      return { js: "", diagnostics: [{ message: String((e as Error).message), line: 1, column: 1, severity: "error" as const }] }
    }
  }
}

/** Same worker source and cancel semantics as `SandboxRunner`, minus the iframe (Bun has no DOM). */
export const workerRunner = (prelude: string, bundle: unknown): Runner & { dispose: () => void } => {
  const url = URL.createObjectURL(new Blob([workerSource(prelude)], { type: "text/javascript" }))
  let worker!: Worker
  let active: { runId: number; settle: (o: RunOutcome) => void } | undefined
  let nextId = 1
  const spawn = (): Promise<void> => new Promise((resolve) => {
    worker = new Worker(url)
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === "pong") return resolve()
      if (active && m.runId === active.runId) {
        if (m.type === "result") active.settle({ ok: true, value: m.value, ms: m.ms })
        else if (m.type === "error") active.settle({ ok: false, reason: "error", message: m.message })
      }
    }
    worker.postMessage({ type: "load", bundle })
    worker.postMessage({ type: "ping", id: 0 })
  })
  const ready = spawn()
  const cancel = async (reason: "cancelled" | "timeout" = "cancelled") => {
    const a = active
    worker.terminate()
    a?.settle({ ok: false, reason, message: reason })
    await spawn()
  }
  return {
    run: async (js, opts) => {
      await ready
      const runId = nextId++
      return new Promise<RunOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = (o: RunOutcome) => { clearTimeout(timer); if (active?.runId === runId) active = undefined; resolve(o) }
        active = { runId, settle }
        if (opts.timeoutMs) timer = setTimeout(() => void cancel("timeout"), opts.timeoutMs)
        worker.postMessage({ type: "run", runId, js })
      })
    },
    cancel: () => cancel(),
    dispose: () => worker.terminate()
  }
}

export const preludeFor = async () => toPrelude(await buildLibraryJs())
