import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../../../tools/build.ts"

test("placeholder site when no shell build exists", () => {
  const out = join(mkdtempSync(join(tmpdir(), "dlq-")), "dist")
  build("prod", out, join(out, "no-shell"))
  expect(readFileSync(join(out, "index.html"), "utf8")).toContain("Hello from the prod build")
  expect(existsSync(join(out, ".nojekyll"))).toBe(true)
})

test("copies the shell build when present", () => {
  const d = mkdtempSync(join(tmpdir(), "dlq-"))
  mkdirSync(join(d, "shell")); writeFileSync(join(d, "shell/index.html"), "SHELL")
  build("dev", join(d, "out"), join(d, "shell"))
  expect(readFileSync(join(d, "out/index.html"), "utf8")).toBe("SHELL")
})
