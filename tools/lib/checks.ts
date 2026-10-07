import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

export interface ScopeOptions {
  /** PR carries the `infra` chore label: may touch root files. */
  readonly infra?: boolean
  readonly branch?: string
}

const moduleOf = (f: string): string | undefined => /^modules\/([^/]+)\//.exec(f)?.[1]
const isSemantics = (f: string) => /^modules\/spatial-core\/src\/semantics\//.test(f)

/** The map-data pointer: a PR that only bumps it (the publish-data flow) needs no module or infra label. */
export const DATA_POINTER = "data/current-build.json"

/** Every changed file must belong to exactly one module (or bun.lock). */
export const checkScope = (files: ReadonlyArray<string>, opts: ScopeOptions = {}): string[] => {
  const errors: string[] = []
  const pointerOnly = files.length === 1 && files[0] === DATA_POINTER
  const mods = new Set<string>()
  const stray: string[] = []
  for (const f of files) {
    const m = moduleOf(f)
    if (m) mods.add(m)
    else if (f !== "bun.lock") stray.push(f)
  }
  if (!opts.infra && !pointerOnly) {
    if (mods.size > 1) errors.push(`change touches multiple modules: ${[...mods].sort().join(", ")}`)
    if (stray.length) errors.push(`files outside modules/<id>/: ${stray.join(", ")}`)
  }
  if (opts.branch?.startsWith("claude/")) {
    const sem = files.filter(isSemantics)
    if (sem.length) errors.push(`claude/* branches may not touch owner-written semantics: ${sem.join(", ")}`)
  }
  return errors
}

/** If a module's code changed, its STATE.md must change too. */
export const checkState = (files: ReadonlyArray<string>): string[] => {
  const errors: string[] = []
  for (const m of new Set(files.map(moduleOf).filter((x): x is string => !!x))) {
    const own = files.filter((f) => moduleOf(f) === m)
    const touchesCode = own.some((f) => !f.endsWith(".md") && !f.endsWith("module.json"))
    if (touchesCode && !own.includes(`modules/${m}/STATE.md`)) errors.push(`modules/${m}/STATE.md not updated`)
  }
  return errors
}

const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : [p]
  })

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g

/** Modules may import only `contracts` and their module.json `dependsOn`. */
export const checkDeps = (root: string): string[] => {
  const errors: string[] = []
  const modsDir = join(root, "modules")
  for (const id of readdirSync(modsDir)) {
    const jsonPath = join(modsDir, id, "module.json")
    if (!existsSync(jsonPath)) continue
    const allowed = new Set<string>([id, "contracts", ...(JSON.parse(readFileSync(jsonPath, "utf8")).dependsOn ?? [])])
    for (const file of walk(join(modsDir, id, "src")).filter((f) => /\.(ts|tsx)$/.test(f))) {
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
        const spec = m[1]!
        const pkg = /^@deadlock-query\/([^/]+)(\/.*)?$/.exec(spec)
        if (pkg) {
          if (!allowed.has(pkg[1]!)) errors.push(`${file}: ${id} may not import ${pkg[1]}`)
          else if (pkg[2] && pkg[1] !== id) errors.push(`${file}: deep import ${spec} (use package entry)`)
        } else if (/modules\/[^/]+\/src/.test(spec) || /^(\.\.\/)+[^/.][^/]*\/src/.test(spec)) {
          errors.push(`${file}: cross-module relative import ${spec}`)
        }
      }
    }
  }
  return errors
}
