import type { ApiCatalog } from "../docs/catalog.ts"

/** The query-library build output (`dist/`), as the builder consumes it: never imported, only read. Browser-safe (no node imports): this file is part of the package entry. */
export interface LibraryArtifact {
  readonly apiVersion: string
  /** Worker-safe ESM (`index.js`). */
  readonly js: string
  /** Declaration files by name, e.g. `index.d.ts`, `MapContext.d.ts`. */
  readonly dts: Readonly<Record<string, string>>
  /** Top-level exports that must be visible as globals in the editor and at runtime. */
  readonly globals: ReadonlyArray<{ readonly name: string; readonly kind: "class" | "const" | "interface" | "type" }>
  /** `apiCatalog.json`: powers the docs panel, hover links and friendly errors. Absent in artifacts built before M4. */
  readonly catalog?: ApiCatalog
  /** Browser-safe IIFE of spatial-core's `Raycaster` and `NavMesh` (`globalThis.__dlqSpatial`), loaded in the worker only for bundles with baked data. */
  readonly spatial?: string
}

const EXPORT_BLOCK = /export\s*\{([^}]*)\}\s*;?\s*$/

/**
 * Turns the library ESM into a classic-script prelude for the query Worker: the trailing
 * `export { a, b as c }` becomes global assignments, and `__dlqLoad(bundle)` defines `map`.
 */
export const toPrelude = (js: string, spatial?: string): string => {
  const m = EXPORT_BLOCK.exec(js)
  if (!m) throw new Error("query-library index.js has no trailing `export { ... }` block")
  const assigns = m[1]!.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, exported = local] = s.split(/\s+as\s+/)
    return `globalThis[${JSON.stringify(exported)}] = ${local};`
  })
  return `${spatial ? `${spatial}\n` : ""}${js.slice(0, m.index)}\n${assigns.join("\n")}\nglobalThis.__dlqLoad = (bundle) => { globalThis.map = MapContext.fromBundle(bundle); };\n`
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
