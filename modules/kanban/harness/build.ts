import { cpSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dir
export const OUT = join(here, ".app-dist")

export const buildHarness = async (): Promise<string> => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const r = await Bun.build({ entrypoints: [join(here, "main.tsx")], outdir: OUT, naming: "[name].[ext]" })
  if (!r.success) throw new Error(r.logs.join("\n"))
  cpSync(join(here, "index.html"), join(OUT, "index.html"))
  return OUT
}

if (import.meta.main) console.log(`kanban harness built: ${await buildHarness()}`)
