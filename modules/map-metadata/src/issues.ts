import type { Vec3 } from "@deadlock-query/contracts"

/** `error` makes a file or submission invalid; `warning` is shown to the reviewer but does not block. */
export type Severity = "error" | "warning"

export interface Issue {
  readonly severity: Severity
  /** Stable machine-readable code, e.g. `polygon-self-intersects`; tests and the review UI key on it. */
  readonly code: string
  readonly message: string
  readonly recordId?: string
  /** Where to point the camera: the offending vertex or position, when there is one. */
  readonly at?: Vec3
}

export interface ValidationReport {
  readonly issues: ReadonlyArray<Issue>
  /** No errors (warnings allowed). */
  readonly ok: boolean
  /** True when no collision probe was given, so surface and solid checks were skipped (bounds checks only). */
  readonly degraded: boolean
}

export const issue = (severity: Severity, code: string, message: string, extra: { recordId?: string; at?: Vec3 } = {}): Issue => ({
  severity, code, message,
  ...(extra.recordId !== undefined ? { recordId: extra.recordId } : {}),
  ...(extra.at !== undefined ? { at: extra.at } : {})
})

export const makeReport = (issues: ReadonlyArray<Issue>, degraded: boolean): ValidationReport => ({
  issues, ok: !issues.some((i) => i.severity === "error"), degraded
})
