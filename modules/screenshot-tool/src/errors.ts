import { Data } from "effect"

/** Anything that goes wrong talking to the game console. `remediation` is shown to the user verbatim. */
export class ConsoleError extends Data.TaggedError("ConsoleError")<{
  readonly kind: "connect" | "timeout" | "closed" | "rejected"
  readonly detail: string
  readonly remediation: string
}> {}

/** Stable CLI exit codes. */
export const EXIT = { ok: 0, usage: 1, problem: 2 } as const
