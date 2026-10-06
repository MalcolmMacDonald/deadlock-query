import type { ModuleDefinition } from "@deadlock-query/contracts"
import { dummyAlpha, dummyBeta, dummyBroken } from "./dummy/modules.tsx"

/** `?demoFailure` adds a module whose Layer fails, to demo/test error isolation. */
const demoFailure = typeof location !== "undefined" && new URLSearchParams(location.search).has("demoFailure")

/** Explicit, static module list. Replace dummies with real module entries as they appear. */
export const modules: ReadonlyArray<ModuleDefinition<any>> = [dummyAlpha, dummyBeta, ...(demoFailure ? [dummyBroken] : [])]
