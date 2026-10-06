import { checkBudgets } from "./lib/budget.ts"
import { buildApp } from "../modules/query-builder/src/app/build.ts"
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

export const placeholderHtml = (target: string) =>
  `<!doctype html><meta charset="utf-8"><title>Deadlock Query</title><h1>Deadlock Query</h1><p>Hello from the ${target} build. The shell is not built yet.</p>\n`

/** Assemble the static site into `out`. Uses the shell build when it exists, else a placeholder. */
export const build = (target: "prod" | "dev", out = "dist", shellDist = "modules/shell/dist", editorDist?: string): string => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  if (existsSync(shellDist)) cpSync(shellDist, out, { recursive: true })
  else writeFileSync(`${out}/index.html`, placeholderHtml(target))
  if (editorDist && existsSync(editorDist)) cpSync(editorDist, `${out}/editor`, { recursive: true })
  writeFileSync(`${out}/.nojekyll`, "")
  return out
}

if (import.meta.main) {
  const i = process.argv.indexOf("--target")
  const target = i >= 0 ? process.argv[i + 1] : "prod"
  if (target !== "prod" && target !== "dev") { console.error("--target must be prod|dev"); process.exit(1) }
  // The shell reads VITE_TARGET at build time: a dev build keeps dev-only modules and the login lock screen.
  const vite = Bun.spawnSync(["bun", "run", "--filter", "@deadlock-query/shell", "build"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, VITE_TARGET: target },
  })
  if (vite.exitCode !== 0) { console.error("shell build failed"); process.exit(1) }
  const editorDist = await buildApp()
  const out = build(target, "dist", "modules/shell/dist", editorDist)
  const errors = checkBudgets(out)
  if (errors.length) { console.error(errors.map((e) => `✗ budget: ${e}`).join("\n")); process.exit(1) }
  console.log(`built ${target} -> ${out} (within budgets)`)
}
