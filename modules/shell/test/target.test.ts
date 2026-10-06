import { expect, test } from "bun:test"
import { Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import { modulesFor, requiresLogin, type ModuleEntry } from "../src/modules.ts"
import { resolveTarget } from "../src/target.ts"

const mod = (id: string): ModuleDefinition => ({ id, layer: Layer.empty, panels: [] })
const entries: ReadonlyArray<ModuleEntry> = [{ module: mod("public") }, { module: mod("secret"), devOnly: true }]

test("target: explicit flag wins; otherwise the dev server is dev and any build is prod", () => {
  expect(resolveTarget("dev", false)).toBe("dev")
  expect(resolveTarget("prod", true)).toBe("prod")
  expect(resolveTarget(undefined, true)).toBe("dev")
  expect(resolveTarget(undefined, false)).toBe("prod")
  expect(resolveTarget("staging", false)).toBe("prod")
})

test("prod omits dev-only modules, dev keeps them", () => {
  expect(modulesFor(entries, "prod").map((m) => m.id)).toEqual(["public"])
  expect(modulesFor(entries, "dev").map((m) => m.id)).toEqual(["public", "secret"])
})

test("login is required only on dev builds that ship a dev-only module", () => {
  expect(requiresLogin(entries, "dev")).toBe(true)
  expect(requiresLogin(entries, "prod")).toBe(false)
  expect(requiresLogin([{ module: mod("public") }], "dev")).toBe(false)
})
