import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildMiniMap } from "@deadlock-query/contracts"
import { readLibraryArtifact } from "../engine/library.ts"

const here = import.meta.dir
export const OUT = join(here, "..", "..", ".app-dist")
const monaco = dirname(Bun.resolveSync("monaco-editor/package.json", here))

const LIBRARY_DIST = join(here, "..", "..", "..", "query-library", "dist")

/** The library is consumed as a built artifact; build it first when it is missing. */
export const ensureLibraryBuilt = (): string => {
  if (!existsSync(join(LIBRARY_DIST, "apiCatalog.json"))) {
    const r = Bun.spawnSync(["bun", "run", "build"], { cwd: join(LIBRARY_DIST, ".."), stdout: "inherit", stderr: "inherit" })
    if (r.exitCode !== 0) throw new Error("query-library build failed")
  }
  return LIBRARY_DIST
}

/**
 * The `library.json` the panel loads (`fetchLibraryArtifact`): the query-library build plus the spatial runtime for baked bundles.
 * Standalone so the shell can publish it without the standalone editor app.
 */
export const buildLibraryJson = async (): Promise<string> => {
  const spatial = await Bun.build({ entrypoints: [join(here, "..", "spatial", "runtime.ts")], target: "browser", format: "iife", minify: true })
  if (!spatial.success) throw new Error(spatial.logs.join("\n"))
  return JSON.stringify({ ...readLibraryArtifact(ensureLibraryBuilt()), spatial: await spatial.outputs[0]!.text() })
}

/** Builds the standalone editor app (Monaco + workers) into `.app-dist/`. */
export const buildApp = async (): Promise<string> => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const r = await Bun.build({
    entrypoints: [
      join(here, "main.ts"),
      join(monaco, "esm/vs/editor/editor.worker.js"),
      join(monaco, "esm/vs/language/typescript/ts.worker.js"),
    ],
    outdir: OUT,
    naming: "[name].[ext]",
    minify: true,
    loader: { ".ttf": "file" },
  })
  if (!r.success) throw new Error(r.logs.join("\n"))
  cpSync(join(here, "index.html"), join(OUT, "index.html"))
  // Library artifact + the fixture bundle (standalone mode; the shell supplies real bundles later).
  writeFileSync(join(OUT, "library.json"), await buildLibraryJson())
  const mini = buildMiniMap()
  writeFileSync(join(OUT, "bundle.json"), JSON.stringify({ manifest: { mapName: mini.manifest.mapName, gameBuildId: mini.manifest.gameBuildId }, entities: mini.entities }))
  return OUT
}

export const serve = (dir: string, port = 0) =>
  Bun.serve({
    port,
    fetch: (req) => {
      const p = new URL(req.url).pathname
      const f = Bun.file(join(dir, p === "/" ? "index.html" : p))
      return f.size ? new Response(f) : new Response("not found", { status: 404 })
    },
  })

if (import.meta.main) {
  const dir = await buildApp()
  const s = serve(dir, 5173)
  console.log(`query-builder standalone: http://localhost:${s.port}/`)
}
