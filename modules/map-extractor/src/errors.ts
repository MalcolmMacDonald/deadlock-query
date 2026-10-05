import { Data } from "effect"

export class GameNotFound extends Data.TaggedError("GameNotFound")<{ readonly tried: ReadonlyArray<string>; readonly remediation: string }> {}
export class ToolMissing extends Data.TaggedError("ToolMissing")<{ readonly tool: string; readonly remediation: string }> {}
export class ExportFailed extends Data.TaggedError("ExportFailed")<{ readonly stage: string; readonly stderr: string }> {}
export class SchemaMismatch extends Data.TaggedError("SchemaMismatch")<{ readonly detail: string }> {}

/** Stable CLI exit codes. */
export const EXIT = { ok: 0, usage: 1, problem: 2 } as const
