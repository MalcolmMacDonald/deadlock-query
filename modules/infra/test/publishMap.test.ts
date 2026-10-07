import { expect, test } from "bun:test"
import { join } from "node:path"
import { buildSteps, extractStep, parsePublishMapArgs, pointerPr, syncSteps, type PublishMapOptions } from "../../../tools/lib/publishMap.ts"

const opts = (o: Partial<PublishMapOptions> = {}): PublishMapOptions => ({ tier: "lite", force: false, noPr: false, dryRun: false, ...o })
const parsed = (argv: string[]) => parsePublishMapArgs(argv) as PublishMapOptions

test("no arguments means the lite tier of the default map, everything on", () => {
  expect(parsePublishMapArgs([])).toEqual({ tier: "lite", force: false, noPr: false, dryRun: false })
})

test("flags are read and bad ones are refused with a reason", () => {
  expect(parsed(["--map", "dl_hideout", "--tier", "full", "--force", "--no-pr", "--dry-run", "--bundle", "x/y"]))
    .toEqual({ map: "dl_hideout", tier: "full", force: true, bundle: "x/y", noPr: true, dryRun: true })
  expect(parsePublishMapArgs(["--tier", "huge"])).toEqual({ error: "--tier must be lite or full, got huge" })
  expect(parsePublishMapArgs(["--map"])).toEqual({ error: "--map needs a value" })
  expect(parsePublishMapArgs(["--map", "../x"])).toEqual({ error: "unsafe map name ../x" })
  expect(parsePublishMapArgs(["--nope"])).toEqual({ error: "unknown argument --nope" })
})

test("the pipeline runs tile before bake, then the checks, then the upload", () => {
  const names = buildSteps("bun", opts(), "/b").map((s) => s.name)
  expect(names).toEqual(["tile", "bake", "inspect", "pack-lite check", "check every file against the manifest", "zip, upload to the GitHub Release, update the pointer"])
  const steps = buildSteps("bun", opts(), "/b")
  expect(steps[4]!.cwd).toBe(join("modules", "contracts"))
  expect(steps[5]!.args).toContain("--upload")
  expect(steps.every((s) => s.args.includes("/b"))).toBe(true)
})

test("--force reaches extract and bake; the full tier skips the lite-only size check", () => {
  expect(extractStep("bun", opts({ force: true, map: "m" })).args).toEqual(expect.arrayContaining(["extract", "--tier", "lite", "--keep-work", "--json", "--map", "m", "--force"]))
  expect(extractStep("bun", opts()).args).not.toContain("--force")
  expect(buildSteps("bun", opts({ force: true }), "/b")[1]!.args).toContain("--force")
  expect(buildSteps("bun", opts({ tier: "full" }), "/b").map((s) => s.name)).not.toContain("pack-lite check")
})

test("main is brought up to date before anything runs", () => {
  expect(syncSteps("bun").map((s) => [s.cmd, ...s.args].join(" "))).toEqual(["git checkout main", "git pull --ff-only origin main", "bun install"])
})

test("the pointer PR is an [infra] PR on data/<buildId> that names the asset hash", () => {
  const pr = pointerPr({ buildId: "42", mapName: "dl_midtown", tier: "lite" }, "ab".repeat(32))
  expect(pr.branch).toBe("data/42")
  expect(pr.title).toBe("[infra] Map data: dl_midtown build 42 (lite)")
  expect(pr.body).toContain("ab".repeat(32))
  expect(pr.body).toContain("data-42")
})
