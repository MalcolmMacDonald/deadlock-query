import { cpSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dir
export const OUT = join(here, ".app-dist")

/** Builds the standalone harness (editor panel + a canvas mock viewer) into `harness/.app-dist/`. */
export const buildHarness = async (): Promise<string> => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const r = await Bun.build({ entrypoints: [join(here, "main.ts")], outdir: OUT, naming: "[name].[ext]", minify: false })
  if (!r.success) throw new Error(r.logs.join("\n"))
  cpSync(join(here, "index.html"), join(OUT, "index.html"))
  return OUT
}

export const serve = (dir: string, port = 0) =>
  Bun.serve({ port, fetch: async (req) => {
    const path = new URL(req.url).pathname
    const f = Bun.file(join(dir, path === "/" ? "index.html" : path))
    return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 })
  } })

if (import.meta.main) {
  const s = serve(await buildHarness(), 4173)
  console.log(`map-metadata editor harness: http://localhost:${s.port}/`)
}
