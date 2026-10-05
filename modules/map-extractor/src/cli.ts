#!/usr/bin/env bun
import { doctor } from "./doctor.ts"
import { EXIT } from "./errors.ts"
import { listMaps, locateGame } from "./steam.ts"
import { GameNotFound } from "./errors.ts"

const USAGE = `dlq-extract <command> [--json] [--game-dir <path>]
  doctor     check Deadlock install, build id and Source2Viewer CLI
  list-maps  maps present in the game paks
(extract, bake, pack-lite, inspect, diff: not implemented yet)`

export const main = (argv: ReadonlyArray<string>): number => {
  const [cmd, ...rest] = argv
  const json = rest.includes("--json")
  const gi = rest.indexOf("--game-dir")
  const gameDir = gi >= 0 ? rest[gi + 1] : undefined
  const out = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text)

  if (cmd === "doctor") {
    const r = doctor({ gameDir })
    out(r, r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n"))
    return r.ok ? EXIT.ok : EXIT.problem
  }
  if (cmd === "list-maps") {
    try {
      const maps = listMaps(locateGame({ gameDir }))
      out({ maps }, maps.join("\n"))
      return EXIT.ok
    } catch (e) {
      if (!(e instanceof GameNotFound)) throw e
      out({ error: e._tag, remediation: e.remediation }, e.remediation)
      return EXIT.problem
    }
  }
  console.error(USAGE)
  return cmd === undefined || cmd === "--help" ? EXIT.ok : EXIT.usage
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
