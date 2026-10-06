import ts from "typescript"
import { join } from "node:path"
import { buildCatalog } from "../../query-library/scripts/catalog.ts"
import { buildDocIndex, type ApiCatalog } from "../src/docs/catalog.ts"
import { globalsShim } from "../src/engine/prelude.ts"

const libSrc = join(import.meta.dir, "../../query-library/src")

/** The catalog straight from library source: race-free (no `dist/`, which the library's own build rewrites). */
export const catalogFromSource = (): ApiCatalog => ({ apiVersion: "test", entries: buildCatalog(libSrc) })
export const docIndexFromSource = () => buildDocIndex(catalogFromSource())

/** Type-checks query sources the way the editor does: globals from the shim, library types from its source. */
export const typecheck = (sources: Readonly<Record<string, string>>): Record<string, string[]> => {
  const catalog = catalogFromSource()
  const shimPath = join(libSrc, "__globals.d.ts")
  const shim = globalsShim({ apiVersion: "test", js: "", dts: {}, globals: catalog.entries.map((e) => ({ name: e.name, kind: e.kind as "class" | "const" | "interface" | "type" })) })
  const virtual = new Map<string, string>([[shimPath, shim]])
  const files = Object.fromEntries(Object.entries(sources).map(([name, src]) => [join(libSrc, `__q_${name}.ts`), src]))
  for (const [p, s] of Object.entries(files)) virtual.set(p, s)
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, types: [],
  }
  const host = ts.createCompilerHost(options)
  const { fileExists, readFile, getSourceFile } = host
  host.fileExists = (f) => virtual.has(f) || fileExists(f)
  host.readFile = (f) => virtual.get(f) ?? readFile(f)
  host.getSourceFile = (f, lang, onError) => (virtual.has(f) ? ts.createSourceFile(f, virtual.get(f)!, lang) : getSourceFile(f, lang, onError))
  const program = ts.createProgram([shimPath, ...Object.keys(files)], options, host)
  const out: Record<string, string[]> = {}
  for (const [name] of Object.entries(sources)) {
    const sf = program.getSourceFile(join(libSrc, `__q_${name}.ts`))!
    out[name] = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
  }
  return out
}
