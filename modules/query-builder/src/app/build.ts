import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const here = import.meta.dir
export const OUT = join(here, "..", "..", ".app-dist")
const monaco = dirname(Bun.resolveSync("monaco-editor/package.json", here))

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
