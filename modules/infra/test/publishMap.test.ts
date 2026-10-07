import { expect, test } from "bun:test"
import { branchName, bundleDir, parsePublishMapArgs, planSteps, prBody, prTitle, type PublishMapOptions } from "../../../tools/lib/publishMap.ts"

const base: PublishMapOptions = { dryRun: false, rebuild: false, force: false }
const asset = { name: "dl_midtown-42-lite-abcdef123456.zip", sha256: "abcdef123456".padEnd(64, "0"), dest: "data/dl_midtown" }
const names = (o: PublishMapOptions, ready: boolean) => planSteps(o, "42", ready, "/abs").map((s) => s.name)

test("arguments", () => {
  expect(parsePublishMapArgs([])).toEqual(base)
  expect(parsePublishMapArgs(["--dry-run", "--map", "dl_x", "--game-dir", "D:\\g"])).toEqual({ ...base, dryRun: true, map: "dl_x", gameDir: "D:\\g" })
  expect(parsePublishMapArgs(["--force"])).toEqual({ ...base, force: true, rebuild: true })
  expect(parsePublishMapArgs(["--map"])).toEqual({ error: "--map needs a value" })
  expect(parsePublishMapArgs(["--map", "../x"])).toHaveProperty("error")
  expect(parsePublishMapArgs(["--nope"])).toEqual({ error: "unknown argument --nope" })
})

test("a complete bundle skips the build steps, an incomplete one runs them in order", () => {
  expect(names(base, true)).toEqual(["inspect", "pack-lite", "check:real", "upload"])
  expect(names(base, false)).toEqual(["extract", "tile", "bake", "inspect", "pack-lite", "check:real", "upload"])
  expect(names({ ...base, rebuild: true }, true).slice(0, 3)).toEqual(["extract", "tile", "bake"])
})

test("dry run never uploads", () => {
  const steps = planSteps({ ...base, dryRun: true }, "42", true, "/abs")
  const last = steps[steps.length - 1]!
  expect(last.cmd).toEqual(["bun", "tools/publish-data.ts", "data/bundles/42/lite"])
  expect(steps.some((s) => s.cmd.includes("--upload"))).toBe(false)
  expect(planSteps(base, "42", true, "/abs").pop()!.cmd).toContain("--upload")
})

test("flags reach the right steps", () => {
  const steps = planSteps({ ...base, rebuild: true, force: true, map: "dl_x", gameDir: "/g" }, "42", true, "/abs")
  const by = (n: string) => steps.find((s) => s.name === n)!.cmd
  expect(by("extract")).toEqual(expect.arrayContaining(["--keep-work", "--force", "--map", "dl_x", "--game-dir", "/g"]))
  expect(by("tile")).not.toContain("--force") // tile refuses nothing, it only reads what extract wrote
  expect(by("bake")).toContain("--force")
  expect(planSteps(base, "42", true, "/abs").find((s) => s.name === "check:real")).toMatchObject({ cwd: "modules/contracts", cmd: ["bun", "scripts/check-real.ts", "/abs"] })
  expect(bundleDir("42")).toBe("data/bundles/42/lite")
})

test("branch and PR text", () => {
  expect(branchName("42", asset)).toBe("data/42-abcdef123456")
  expect(prTitle("42", asset)).toBe("Publish map data 42 (abcdef123456)")
  expect(prBody("42", asset)).toContain(asset.name)
})
