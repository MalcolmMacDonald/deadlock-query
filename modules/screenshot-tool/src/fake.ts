import { Effect, Layer } from "effect"
import { GameConsole } from "./console.ts"
import { ConsoleError } from "./errors.ts"
import { placeholderPng } from "./image.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface FakeConsoleOptions {
  /** Commands the fake game refuses (as if cheat-gated). */
  readonly rejected?: ReadonlyArray<string>
  /** Added to the position after `setpos`, simulating a game that does not honour the pose (pose verification tests). */
  readonly poseDrift?: readonly [number, number, number]
  /** Delay every reply, simulating a busy game. */
  readonly delayMs?: number
  /** Where `screenshot` writes placeholder PNGs, like the game's screenshot folder. Without it the command only replies. */
  readonly screenshotDir?: string
  /** Size of the placeholder images (default 64x36). */
  readonly imageSize?: { readonly width: number; readonly height: number }
  /** The file shows up this long after the command replies, like a game that writes the image a frame later. */
  readonly fileDelayMs?: number
  /** Reply "Wrote ..." but never write the file (pickup timeout tests). */
  readonly dropFiles?: boolean
}

export interface FakeGame {
  /** Every command received, in order. */
  readonly log: string[]
  readonly state: { pos: [number, number, number]; ang: [number, number, number]; screenshots: number }
  readonly layer: Layer.Layer<GameConsole>
}

const nums = (args: ReadonlyArray<string>, n: number): number[] | undefined => {
  const v = args.slice(0, n).map(Number)
  return v.length === n && v.every(Number.isFinite) ? v : undefined
}

/**
 * In-memory stand-in for the game console: understands `echo`, `setpos`, `setang`, `getpos`, `screenshot`,
 * and answers anything else with an "Unknown command" line like Source does. Used by tests, CI and `--fake`.
 */
export const makeFakeGame = (opts: FakeConsoleOptions = {}): FakeGame => {
  const log: string[] = []
  const state: FakeGame["state"] = { pos: [0, 0, 0], ang: [0, 0, 0], screenshots: 0 }
  const handle = (command: string): Effect.Effect<string, ConsoleError> => {
    log.push(command)
    const [name = "", ...args] = command.trim().split(/\s+/)
    if (opts.rejected?.includes(name)) {
      return Effect.fail(new ConsoleError({ kind: "rejected", detail: `${name}: requires cheats`, remediation: "enable cheats (sv_cheats 1) in an offline sandbox session" }))
    }
    switch (name) {
      case "echo": return Effect.succeed(args.join(" "))
      case "setpos": {
        const p = nums(args, 3)
        if (!p) return Effect.succeed("Usage: setpos <x> <y> <z>")
        const d = opts.poseDrift ?? [0, 0, 0]
        state.pos = [p[0]! + d[0], p[1]! + d[1], p[2]! + d[2]]
        return Effect.succeed("")
      }
      case "setang": {
        const a = nums(args, 3) ?? nums([...args, "0"], 3)
        if (!a) return Effect.succeed("Usage: setang <pitch> <yaw> [roll]")
        state.ang = [a[0]!, a[1]!, a[2]!]
        return Effect.succeed("")
      }
      case "getpos": return Effect.succeed(`setpos ${state.pos.join(" ")};setang ${state.ang.join(" ")}`)
      case "screenshot": {
        state.screenshots += 1
        const name = `screenshot${String(state.screenshots).padStart(4, "0")}.png`
        if (opts.screenshotDir !== undefined && !opts.dropFiles) {
          const dir = opts.screenshotDir, size = opts.imageSize ?? { width: 64, height: 36 }
          const png = placeholderPng(size.width, size.height, (state.screenshots * 37) % 256)
          const write = () => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), png) }
          if (opts.fileDelayMs) setTimeout(write, opts.fileDelayMs); else write()
        }
        return Effect.succeed(`Wrote ${name}`)
      }
      case "cl_drawhud": case "fov_desired": case "sv_cheats": case "noclip": return Effect.succeed("")
      default: return Effect.succeed(`Unknown command: ${name}`)
    }
  }
  const send = (command: string) => (opts.delayMs ? Effect.delay(handle(command), opts.delayMs) : handle(command))
  return { log, state, layer: Layer.succeed(GameConsole)({ send }) }
}
