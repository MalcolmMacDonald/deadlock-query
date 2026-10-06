import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** The query-library build output (`dist/`), as the builder consumes it: never imported, only read. */
export interface LibraryArtifact {
  readonly apiVersion: string
  /** Worker-safe ESM (`index.js`). */
  readonly js: string
  /** Declaration files by name, e.g. `index.d.ts`, `MapContext.d.ts`. */
  readonly dts: Readonly<Record<string, string>>
  /** Top-level exports that must be visible as globals in the editor and at runtime. */
  readonly globals: ReadonlyArray<{ readonly name: string; readonly kind: "class" | "const" | "interface" | "type" }>
}

const EXPORT_BLOCK = /export\s*\{([^}]*)\}\s*;?\s*$/

/**
 * Turns the library ESM into a classic-script prelude for the query Worker: the trailing
 * `export { a, b as c }` becomes global assignments, and `__dlqLoad(bundle)` defines `map`.
 */
export const toPrelude = (js: string): string => {
  const m = EXPORT_BLOCK.exec(js)
  if (!m) throw new Error("query-library index.js has no trailing `export { ... }` block")
  const assigns = m[1]!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, exported = local] = s.split(/\s+as\s+/)
    return `globalThis[${JSON.stringify(exported)}] = ${local};`
  })
  return `${js.slice(0, m.index)}\n${assigns.join("\n")}\nglobalThis.__dlqLoad = (bundle) => { globalThis.map = MapContext.fromBundle(bundle); };\n`
}

/**
 * Ambient declarations that expose the library's exports (and `map`) as globals to the editor's
 * script model. Value exports become `const`s (classes also get a type alias); types alias through.
 */
export const globalsShim = (lib: LibraryArtifact): string => {
  const lines = ['import * as L from "./index"', "declare global {", "  const map: L.MapContext"]
  for (const g of lib.globals) {
    if (g.name === "MapContext" || g.kind === "const" || g.kind === "class") lines.push(`  const ${g.name}: typeof L.${g.name}`)
    if (g.kind !== "const") lines.push(`  type ${g.name} = L.${g.name}`)
  }
  lines.push("}", "export {}")
  return lines.join("\n")
}

/** Reads `dist/` of query-library. Throws if it has not been built. */
export const readLibraryArtifact = (dir: string): LibraryArtifact => {
  const index = join(dir, "index.js")
  if (!existsSync(index)) throw new Error(`query-library is not built (missing ${index}); run \`bun run build\` in modules/query-library`)
  const catalog = JSON.parse(readFileSync(join(dir, "apiCatalog.json"), "utf8")) as {
    apiVersion: string
    entries: Array<{ name: string; kind: LibraryArtifact["globals"][number]["kind"] }>
  }
  const dts: Record<string, string> = {}
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".d.ts"))) dts[f] = readFileSync(join(dir, f), "utf8")
  return {
    apiVersion: catalog.apiVersion,
    js: readFileSync(index, "utf8"),
    dts,
    globals: catalog.entries.map((e) => ({ name: e.name, kind: e.kind }))
  }
}
