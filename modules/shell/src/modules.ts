import type { ModuleDefinition } from "@deadlock-query/contracts"
import { editorModule } from "./editor.tsx"
import { dummyBroken } from "./dummy/modules.tsx"
import { viewerModule } from "./viewer.ts"

/** `?demoFailure` adds a module whose Layer fails, to demo/test error isolation. */
const demoFailure = typeof location !== "undefined" && new URLSearchParams(location.search).has("demoFailure")

/** Explicit, static module list. */
export const modules: ReadonlyArray<ModuleDefinition<any>> = [viewerModule, editorModule, ...(demoFailure ? [dummyBroken] : [])]
