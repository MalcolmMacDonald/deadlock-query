import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { GameConsole, NetConPort, netConSend } from "../src/console.ts"
import { doctor } from "../src/doctor.ts"
import { makeFakeGame } from "../src/fake.ts"

const run = <A, E>(e: Effect.Effect<A, E, GameConsole>, layer = makeFakeGame().layer) => Effect.runPromise(e.pipe(Effect.provide(layer)))
const send = (c: string, layer?: ReturnType<typeof makeFakeGame>["layer"]) => run(GameConsole.use((g) => g.send(c)), layer)

test("fake console: echo and pose round-trip", async () => {
  const game = makeFakeGame()
  expect(await send("echo hi", game.layer)).toBe("hi")
  await send("setpos 1 2 3", game.layer)
  await send("setang 10 20", game.layer)
  expect(await send("getpos", game.layer)).toBe("setpos 1 2 3;setang 10 20 0")
  expect(await send("screenshot", game.layer)).toContain("screenshot0001.jpg")
  expect(game.state.screenshots).toBe(1)
  expect(game.log).toEqual(["echo hi", "setpos 1 2 3", "setang 10 20", "getpos", "screenshot"])
  expect(await send("nope", game.layer)).toBe("Unknown command: nope")
})

test("fake console: cheat-gated commands fail with remediation, pose drift is observable", async () => {
  const gated = makeFakeGame({ rejected: ["noclip"] })
  const r = await Effect.runPromise(GameConsole.use((g) => g.send("noclip")).pipe(Effect.provide(gated.layer), Effect.result))
  expect(r._tag).toBe("Failure")
  if (r._tag === "Failure") expect(r.failure.kind).toBe("rejected")
  const drift = makeFakeGame({ poseDrift: [5, 0, 0] })
  await send("setpos 0 0 0", drift.layer)
  expect(await send("getpos", drift.layer)).toContain("setpos 5 0 0")
})

const echoServer = async (reply: (line: string) => string | null): Promise<{ server: Server; port: number }> => {
  const server = createServer((s) => s.on("data", (d) => { const r = reply(String(d).trim()); if (r === null) s.end(); else s.write(`${r}\n`) }))
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { server, port: (server.address() as { port: number }).port }
}

test("NetConPort talks to a TCP console", async () => {
  const { server, port } = await echoServer((l) => l.replace(/^echo /, ""))
  try {
    expect(await send("echo hi", NetConPort({ port, settleMs: 30 }))).toBe("hi")
  } finally { server.close() }
})

test("NetConPort reports a refused connection with the launch option to use", async () => {
  const { server, port } = await echoServer(() => "x")
  await new Promise((ok) => server.close(ok))
  const r = await Effect.runPromise(netConSend({ host: "127.0.0.1", port, timeoutMs: 500, settleMs: 30 }, "echo hi").pipe(Effect.result))
  expect(r._tag).toBe("Failure")
  if (r._tag === "Failure") {
    expect(r.failure.kind).toBe("connect")
    expect(r.failure.remediation).toContain(`-netconport ${port}`)
  }
})

test("NetConPort: silent server times out, closing server without reply is reported", async () => {
  const silent = createServer(() => {})
  await new Promise<void>((ok) => silent.listen(0, "127.0.0.1", ok))
  const sp = (silent.address() as { port: number }).port
  const t = await Effect.runPromise(netConSend({ host: "127.0.0.1", port: sp, timeoutMs: 100, settleMs: 30 }, "x").pipe(Effect.result))
  silent.close()
  expect(t._tag === "Failure" && t.failure.kind).toBe("timeout")
  const { server, port } = await echoServer(() => null)
  const c = await Effect.runPromise(netConSend({ host: "127.0.0.1", port, timeoutMs: 500, settleMs: 30 }, "x").pipe(Effect.result))
  server.close()
  expect(c._tag === "Failure" && c.failure.kind).toBe("closed")
})

test("doctor: all green with a running game, console and screenshot dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-shoot-"))
  mkdirSync(join(dir, "game", "citadel", "screenshots"), { recursive: true })
  const r = await run(doctor({ port: 2121, gameDir: dir, processes: () => ["steam.exe", "deadlock.exe"] }))
  expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["game-process", true], ["console", true], ["screenshot-dir", true], ["offline-mode", true]])
  expect(r.ok).toBe(true)
  expect(r.launchOptions).toContain("-netconport 2121")
})

test("doctor: reports every failure with a fix", async () => {
  const r = await run(doctor({ port: 2121, processes: () => [] }), NetConPort({ port: 1, timeoutMs: 300 }))
  expect(r.ok).toBe(false)
  expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["game-process", "console", "screenshot-dir"])
  expect(r.checks.filter((c) => !c.ok).every((c) => c.fix)).toBe(true)
})

const capture = async (f: () => Promise<number>) => {
  const lines: string[] = []
  const log = console.log, err = console.error
  console.log = (...a: unknown[]) => void lines.push(a.join(" "))
  console.error = (...a: unknown[]) => void lines.push(a.join(" "))
  try { return { code: await f(), lines } } finally { console.log = log; console.error = err }
}

test("cli: console \"echo hi\" --fake prints hi, exit 0", async () => {
  const r = await capture(() => main(["console", "echo hi", "--fake"], {}))
  expect(r).toEqual({ code: 0, lines: ["hi"] })
})

test("cli: console against a dead port exits 2 with remediation; doctor --fake passes", async () => {
  const dead = await capture(() => main(["console", "echo hi", "--port", "1"], {}))
  expect(dead.code).toBe(2)
  expect(dead.lines.join("\n")).toContain("-netconport 1")
  const d = await capture(() => main(["doctor", "--fake", "--screenshot-dir", tmpdir()], {}))
  expect(d.code).toBe(0)
})

test("cli: usage and bad port", async () => {
  expect((await capture(() => main(["bogus"], {}))).code).toBe(1)
  expect((await capture(() => main([], {}))).code).toBe(0)
  expect((await capture(() => main(["console", "x", "--port", "nope"], {}))).code).toBe(1)
})
