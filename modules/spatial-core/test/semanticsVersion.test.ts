import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SEMANTICS_VERSION } from "../src/index.ts"
import { hashSemantics, render } from "../tools/semantics-version.ts"

test("SEMANTICS_VERSION matches src/semantics (run `bun run semantics-version` in modules/spatial-core after editing them)", () => {
  expect(SEMANTICS_VERSION).toMatch(/^[0-9a-f]{16}$/)
  expect(SEMANTICS_VERSION).toBe(hashSemantics())
  expect(readFileSync(join(import.meta.dir, "..", "src", "semanticsVersion.ts"), "utf8")).toBe(render(SEMANTICS_VERSION))
})
