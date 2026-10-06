import type { ModuleDefinition } from "@deadlock-query/contracts"
import { dummyAlpha, dummyBeta } from "./dummy/modules.tsx"

/** Explicit, static module list. Replace dummies with real module entries as they appear. */
export const modules: ReadonlyArray<ModuleDefinition> = [dummyAlpha, dummyBeta]
