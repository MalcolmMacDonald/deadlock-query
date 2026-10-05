import { checkDeps, checkScope, checkState } from "./lib/checks.ts"

const [cmd, ...args] = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1]

const changed = (): string[] => {
  const base = opt("base") ?? "origin/main"
  const out = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`]).stdout.toString()
  return out.split("\n").filter(Boolean)
}

const errors =
  cmd === "scope" ? checkScope(changed(), { infra: flag("infra"), branch: opt("branch") ?? "" })
  : cmd === "state" ? checkState(changed())
  : cmd === "deps" ? checkDeps(process.cwd())
  : (console.error("usage: check <scope|state|deps> [--base ref] [--infra] [--branch name]"), ["bad usage"])

if (errors.length) { console.error(errors.map((e) => `✗ ${e}`).join("\n")); process.exit(1) }
console.log(`check:${cmd} ok`)
