import { target, type Target } from "./target.ts"

export interface BuildInfo {
  readonly gitSha: string
  readonly builtAt: string
  readonly target: Target
}

declare const __BUILD_INFO__: { readonly gitSha: string; readonly builtAt: string } | undefined

/** Stamped by `vite.config.ts` at build time (git SHA and time); "unknown" when run outside a Vite build (e.g. unit tests). */
export const buildInfo: BuildInfo = {
  gitSha: typeof __BUILD_INFO__ !== "undefined" && __BUILD_INFO__ ? __BUILD_INFO__.gitSha : "unknown",
  builtAt: typeof __BUILD_INFO__ !== "undefined" && __BUILD_INFO__ ? __BUILD_INFO__.builtAt : "unknown",
  target,
}
