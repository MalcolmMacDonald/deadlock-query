import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ApiCatalog } from "../docs/catalog.ts"
import type { LibraryArtifact } from "./prelude.ts"

export { globalsShim, toPrelude, type LibraryArtifact } from "./prelude.ts"

/** Reads `dist/` of query-library. Throws if it has not been built. */
export const readLibraryArtifact = (dir: string): LibraryArtifact => {
  const index = join(dir, "index.js")
  if (!existsSync(index)) throw new Error(`query-library is not built (missing ${index}); run \`bun run build\` in modules/query-library`)
  const catalog = JSON.parse(readFileSync(join(dir, "apiCatalog.json"), "utf8")) as ApiCatalog
  const dts: Record<string, string> = {}
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".d.ts"))) dts[f] = readFileSync(join(dir, f), "utf8")
  return {
    apiVersion: catalog.apiVersion,
    js: readFileSync(index, "utf8"),
    dts,
    globals: catalog.entries.map((e) => ({ name: e.name, kind: e.kind as LibraryArtifact["globals"][number]["kind"] })),
    catalog
  }
}
