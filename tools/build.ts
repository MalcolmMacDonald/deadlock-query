import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

export const placeholderHtml = (target: string) =>
  `<!doctype html><meta charset="utf-8"><title>Deadlock Query</title><h1>Deadlock Query</h1><p>Hello from the ${target} build. The shell is not built yet.</p>\n`

/** Assemble the static site into `out`. Uses the shell build when it exists, else a placeholder. */
export const build = (target: "prod" | "dev", out = "dist", shellDist = "modules/shell/dist"): string => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  if (existsSync(shellDist)) cpSync(shellDist, out, { recursive: true })
  else writeFileSync(`${out}/index.html`, placeholderHtml(target))
  writeFileSync(`${out}/.nojekyll`, "")
  return out
}

if (import.meta.main) {
  const i = process.argv.indexOf("--target")
  const target = i >= 0 ? process.argv[i + 1] : "prod"
  if (target !== "prod" && target !== "dev") { console.error("--target must be prod|dev"); process.exit(1) }
  console.log(`built ${target} -> ${build(target)}`)
}
