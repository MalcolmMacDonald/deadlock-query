import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildCatalog, docProblems } from "./catalog.ts"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// Runtime: one worker-safe ESM file, no Node APIs.
const js = await Bun.build({ entrypoints: [join(root, "src/index.ts")], outdir: dist, target: "browser", format: "esm" })
if (!js.success) { console.error(js.logs.join("\n")); process.exit(1) }

// Declarations for Monaco.
const tsc = Bun.spawnSync([join(root, "../../node_modules/.bin/tsc"), "-p", join(root, "tsconfig.build.json")], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (tsc.exitCode !== 0) process.exit(1)

// Monaco resolves extensionless relative specifiers in a virtual file system.
for (const f of readdirSync(dist).filter((n) => n.endsWith(".d.ts"))) {
  const p = join(dist, f)
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+|import\s+)(["'])(\.\/[^"']+?)\.(?:ts|js)\2/g, "$1$2$3$2"))
}

// API catalog + docs gate.
const catalog = buildCatalog(join(root, "src"))
const problems = docProblems(catalog)
if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join("\n")); process.exit(1) }
const pkg = await Bun.file(join(root, "package.json")).json()
writeFileSync(join(dist, "apiCatalog.json"), JSON.stringify({ apiVersion: pkg.version, entries: catalog }, null, 2))
writeFileSync(join(dist, "package.json"), JSON.stringify({ name: pkg.name, apiVersion: pkg.version, type: "module", main: "index.js", types: "index.d.ts" }, null, 2))
console.log(`built dist/: ${catalog.length} exports, apiVersion ${pkg.version}`)
