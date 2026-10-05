import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const here = import.meta.dir
export const OUT = join(here, "..", ".spike-dist")
const monaco = dirname(Bun.resolveSync("monaco-editor/package.json", here))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const r = await Bun.build({
  entrypoints: [
    join(here, "entry.ts"),
    join(monaco, "esm/vs/editor/editor.worker.js"),
    join(monaco, "esm/vs/language/typescript/ts.worker.js"),
  ],
  outdir: OUT,
  naming: "[name].[ext]",
  minify: true,
  loader: { ".ttf": "file" },
})
if (!r.success) { console.error(r.logs.join("\n")); process.exit(1) }
cpSync(join(here, "index.html"), join(OUT, "index.html"))
console.log(`built ${r.outputs.length} files → ${OUT}`)
