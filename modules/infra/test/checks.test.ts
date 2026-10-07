import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDeps, checkScope, checkState } from "../../../tools/lib/checks.ts"

test("single module + lockfile passes", () => {
  expect(checkScope(["modules/contracts/src/a.ts", "bun.lock"])).toEqual([])
})
test("two-module diff fails", () => {
  expect(checkScope(["modules/contracts/a.ts", "modules/shell/b.ts"])).toHaveLength(1)
})
test("root files fail unless infra", () => {
  expect(checkScope(["package.json"])).toHaveLength(1)
  expect(checkScope(["package.json"], { infra: true })).toEqual([])
})
test("a data-pointer-only PR passes without the infra label", () => {
  expect(checkScope(["data/current-build.json"], { branch: "UpdateMap" })).toEqual([])
  expect(checkScope(["data/current-build.json", "package.json"])).toHaveLength(1)
  expect(checkScope(["data/current-build.json", "modules/shell/a.ts"])).toHaveLength(1)
})
test("claude branch may not touch semantics", () => {
  const f = ["modules/spatial-core/src/semantics/isInterior.ts"]
  expect(checkScope(f, { branch: "claude/x" })).toHaveLength(1)
  expect(checkScope(f, { branch: "feature/x" })).toEqual([])
})
test("code change requires STATE.md", () => {
  expect(checkState(["modules/shell/src/a.ts"])).toHaveLength(1)
  expect(checkState(["modules/shell/src/a.ts", "modules/shell/STATE.md"])).toEqual([])
})
test("deps: disallowed import is flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "dq-"))
  for (const [id, deps] of [["a", []], ["b", []]] as const) {
    mkdirSync(join(root, "modules", id, "src"), { recursive: true })
    writeFileSync(join(root, "modules", id, "module.json"), JSON.stringify({ dependsOn: deps }))
  }
  writeFileSync(join(root, "modules/a/src/x.ts"), `import "@deadlock-query/contracts"\nimport "@deadlock-query/b"\n`)
  expect(checkDeps(root)).toHaveLength(1)
})
