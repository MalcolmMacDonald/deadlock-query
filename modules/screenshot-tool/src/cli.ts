#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { createInterface } from "node:readline"
import { DEFAULT_NETCON, GameConsole, NetConPort } from "./console.ts"
import { doctor } from "./doctor.ts"
import { EXIT } from "./errors.ts"
import { makeFakeGame } from "./fake.ts"

const USAGE = `dlq-shoot <command> [--json] [--fake] [--host <h>] [--port <n>]
  doctor     [--game-dir <dir>] [--screenshot-dir <dir>]   check the game process, console and screenshot folder; print launch options
  console    ["<command>"]   send one console command and print the reply (no argument: read commands from stdin)
  --fake     use the in-memory fake console instead of the game (tests, CI, dry runs)
(plan, shoot, launch, verify: not implemented yet; port defaults to ${DEFAULT_NETCON.port}, set it with --port or DLQ_CONSOLE_PORT)`

const flag = (a: ReadonlyArray<string>, name: string): string | undefined => {
  const i = a.indexOf(name)
  return i >= 0 ? a[i + 1] : undefined
}

/** Positional arguments: everything that is not a flag or a flag's value. */
const positionals = (a: ReadonlyArray<string>): string[] => {
  const withValue = new Set(["--host", "--port", "--game-dir", "--screenshot-dir"])
  return a.filter((x, i) => !x.startsWith("--") && !withValue.has(a[i - 1] ?? ""))
}

export const main = async (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = process.env): Promise<number> => {
  const [cmd, ...rest] = argv
  const json = rest.includes("--json")
  const emit = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text)
  if (cmd !== "doctor" && cmd !== "console") {
    console.error(USAGE)
    return cmd === undefined || cmd === "--help" ? EXIT.ok : EXIT.usage
  }

  const port = Number(flag(rest, "--port") ?? env["DLQ_CONSOLE_PORT"] ?? DEFAULT_NETCON.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid port: ${flag(rest, "--port") ?? env["DLQ_CONSOLE_PORT"]}`)
    return EXIT.usage
  }
  const fake = rest.includes("--fake") ? makeFakeGame() : undefined
  const layer: Layer.Layer<GameConsole> = fake?.layer ?? NetConPort({ host: flag(rest, "--host") ?? DEFAULT_NETCON.host, port })

  if (cmd === "doctor") {
    const r = await Effect.runPromise(doctor({
      port,
      gameDir: flag(rest, "--game-dir") ?? env["DEADLOCK_DIR"],
      screenshotDir: flag(rest, "--screenshot-dir"),
      ...(fake ? { processes: () => ["deadlock.exe"] } : {}),
    }).pipe(Effect.provide(layer)))
    emit(r, [...r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`), `launch options: ${r.launchOptions}`].join("\n"))
    return r.ok ? EXIT.ok : EXIT.problem
  }

  const sendAll = (commands: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const gc = yield* GameConsole
      for (const c of commands) {
        const reply = yield* gc.send(c)
        emit({ command: c, reply }, reply)
      }
    }).pipe(Effect.provide(layer), Effect.result)

  const one = positionals(rest.filter((x) => x !== "--fake" && x !== "--json"))
  let commands = one
  if (one.length === 0) {
    const lines: string[] = []
    for await (const l of createInterface({ input: process.stdin })) if (l.trim()) lines.push(l.trim())
    commands = lines
  }
  const r = await Effect.runPromise(sendAll(commands))
  if (r._tag === "Failure") {
    emit({ error: r.failure._tag, kind: r.failure.kind, detail: r.failure.detail, remediation: r.failure.remediation }, `${r.failure.detail}\n  fix: ${r.failure.remediation}`)
    return EXIT.problem
  }
  return EXIT.ok
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
