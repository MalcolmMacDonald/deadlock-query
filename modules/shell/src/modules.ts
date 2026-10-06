import type { ModuleDefinition } from "@deadlock-query/contracts"
import { editorModule } from "./editor.tsx"
import { dummyBroken, dummyDevOnly } from "./dummy/modules.tsx"
import { target, type Target } from "./target.ts"
import { viewerModule } from "./viewer.ts"

export interface ModuleEntry {
  readonly module: ModuleDefinition<any>
  /** Left out of `prod` builds; on `dev` it sits behind the lock screen until the session is authenticated. */
  readonly devOnly?: boolean
}

const search = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams()
/** `?demoFailure` adds a module whose Layer fails, to demo/test error isolation. */
const demoFailure = search.has("demoFailure")
/** `?demoDevOnly` adds a dev-only module, to demo/test the lock screen (only honoured on the dev target). */
const demoDevOnly = search.has("demoDevOnly")

/** Explicit, static module list. */
export const moduleEntries: ReadonlyArray<ModuleEntry> = [
  { module: viewerModule },
  { module: editorModule },
  ...(demoFailure ? [{ module: dummyBroken }] : []),
  ...(demoDevOnly ? [{ module: dummyDevOnly, devOnly: true }] : []),
]

/** The modules a build for `t` ships: `prod` omits dev-only ones. */
export const modulesFor = (entries: ReadonlyArray<ModuleEntry>, t: Target): ReadonlyArray<ModuleDefinition<any>> =>
  entries.filter((e) => !e.devOnly || t === "dev").map((e) => e.module)

/** True when this build ships dev-only modules, i.e. the app must check `DevAuth` and show the lock screen without a session. */
export const requiresLogin = (entries: ReadonlyArray<ModuleEntry>, t: Target): boolean => t === "dev" && entries.some((e) => e.devOnly)

export const modules: ReadonlyArray<ModuleDefinition<any>> = modulesFor(moduleEntries, target)
export const loginRequired: boolean = requiresLogin(moduleEntries, target)
