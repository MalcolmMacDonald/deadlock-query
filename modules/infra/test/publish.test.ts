import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assetName, bundleFiles, checkBundleBudget, isPublishable, parseBundleManifest, releaseTag, updatePointer } from "../../../tools/lib/publish.ts"

const info = parseBundleManifest({ gameBuildId: "42", mapName: "dl_midtown", tier: "lite" })

test("names and tag", () => {
  expect(assetName(info)).toBe("dl_midtown-42-lite.zip")
  expect(releaseTag(info)).toBe("data-42")
  expect(() => parseBundleManifest({ gameBuildId: "../x", mapName: "m", tier: "lite" })).toThrow()
  expect(() => parseBundleManifest({})).toThrow()
})

test("scratch and stage stamps are excluded", () => {
  expect(isPublishable(".work/x")).toBe(false)
  expect(isPublishable(".stage-render")).toBe(false)
  const d = mkdtempSync(join(tmpdir(), "dlq-"))
  mkdirSync(join(d, ".work")); mkdirSync(join(d, "collision"))
  for (const f of ["manifest.json", ".stage-entities", ".work/a", "collision/physics.glb"]) writeFileSync(join(d, f), "x")
  expect(bundleFiles(d).sort()).toEqual(["collision/physics.glb", "manifest.json"])
  expect(checkBundleBudget(d, bundleFiles(d))).toEqual([])
})

test("updatePointer replaces on a new tag and merges on the same tag", () => {
  const a = updatePointer(undefined, info, "a".repeat(64))
  expect(a.assets).toEqual([{ name: "dl_midtown-42-lite.zip", sha256: "a".repeat(64), dest: "data/dl_midtown" }])
  const b = updatePointer(a, { ...info, mapName: "dl_hideout" }, "b".repeat(64))
  expect(b.assets.length).toBe(2)
  const c = updatePointer(b, info, "c".repeat(64))
  expect(c.assets.find((x) => x.dest === "data/dl_midtown")!.sha256).toBe("c".repeat(64))
  expect(updatePointer(c, { ...info, buildId: "43" }, "d".repeat(64)).assets.length).toBe(1)
})
