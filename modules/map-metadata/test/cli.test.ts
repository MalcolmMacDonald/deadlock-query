import { expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", "scripts/validate.ts", ...args], { cwd: root })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}
const manifest = join(root, "../contracts/fixtures/mini-map/manifest.json")

test("metadata:validate accepts the valid fixture build directory", () => {
  const r = run("fixtures/valid/0", "--manifest", manifest)
  expect(r.out).not.toContain("FAIL")
  expect(r.code).toBe(0)
})

test("metadata:validate accepts the parent of build directories and a submission file", () => {
  const r = run("fixtures/valid", "fixtures/submissions/valid.json", "--manifest", manifest)
  expect(r.out).not.toContain("FAIL")
  expect(r.code).toBe(0)
})

test("metadata:validate rejects crafted bad files with a non-zero exit and names the problem", () => {
  const r = run("fixtures/bad/bowtie-region.json")
  expect(r.code).toBe(1)
  expect(r.out).toContain("polygon-self-intersects")
})

test("metadata:validate with no paths is a usage error; a missing path fails", () => {
  expect(run().code).toBe(2)
  expect(run("fixtures/nope").code).toBe(1)
})
