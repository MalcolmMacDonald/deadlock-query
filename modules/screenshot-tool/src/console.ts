import { Context, Effect, Layer } from "effect"
import { connect } from "node:net"
import { ConsoleError } from "./errors.ts"

/**
 * Transport to the running game's console. One command in, the game's textual reply out.
 * Implementations: `NetConPort` (real game, TCP via `-netconport`) and `FakeConsole` (tests, CI, `--fake`).
 */
export class GameConsole extends Context.Service<
  GameConsole,
  {
    readonly send: (command: string) => Effect.Effect<string, ConsoleError>
  }
>()("@deadlock-query/screenshot-tool/GameConsole") {}

export interface NetConOptions {
  readonly host: string
  readonly port: number
  /** How long to wait for the connection and for the reply to go quiet. */
  readonly timeoutMs: number
  /** Reply is considered complete once no data arrives for this long. */
  readonly settleMs: number
}

export const DEFAULT_NETCON: NetConOptions = { host: "127.0.0.1", port: 2121, timeoutMs: 3000, settleMs: 150 }

const connectFailed = (o: NetConOptions, e: unknown) =>
  new ConsoleError({
    kind: "connect",
    detail: `cannot reach ${o.host}:${o.port}: ${e instanceof Error ? e.message : String(e)}`,
    remediation: `start Deadlock with the launch option \`-netconport ${o.port}\` (offline/sandbox only), then retry`,
  })

/**
 * Plain line-based TCP console (as in other Source 2 titles). **[VERIFY]** against the real game (spike S3):
 * whether Deadlock opens the port, its framing, and whether replies are terminated. One connection per command keeps
 * the implementation stateless; the reply is whatever arrives until the stream goes quiet for `settleMs`.
 */
export const netConSend = (o: NetConOptions, command: string): Effect.Effect<string, ConsoleError> =>
  Effect.callback<string, ConsoleError>((resume) => {
    let settled = false
    let buf = ""
    let quiet: ReturnType<typeof setTimeout> | undefined
    const done = (r: Effect.Effect<string, ConsoleError>) => {
      if (settled) return
      settled = true
      clearTimeout(quiet)
      clearTimeout(deadline)
      socket.destroy()
      resume(r)
    }
    const socket = connect({ host: o.host, port: o.port })
    const deadline = setTimeout(
      () => done(Effect.fail(new ConsoleError({ kind: "timeout", detail: `no reply from ${o.host}:${o.port} in ${o.timeoutMs} ms`, remediation: "check the game is responsive and the console port is the one passed to -netconport" }))),
      o.timeoutMs,
    )
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${command}\n`))
    socket.on("data", (d: string) => {
      buf += d
      clearTimeout(quiet)
      quiet = setTimeout(() => done(Effect.succeed(buf.trimEnd())), o.settleMs)
    })
    socket.once("error", (e) => done(Effect.fail(connectFailed(o, e))))
    socket.once("close", () => done(buf.length > 0 ? Effect.succeed(buf.trimEnd()) : Effect.fail(new ConsoleError({ kind: "closed", detail: "game closed the console connection without replying", remediation: "check the command is valid and cheats are enabled if required" }))))
    return Effect.sync(() => {
      settled = true
      clearTimeout(quiet)
      clearTimeout(deadline)
      socket.destroy()
    })
  })

export const NetConPort = (opts: Partial<NetConOptions> = {}): Layer.Layer<GameConsole> => {
  const o = { ...DEFAULT_NETCON, ...opts }
  return Layer.succeed(GameConsole)({ send: (command) => netConSend(o, command) })
}
