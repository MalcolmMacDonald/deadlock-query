import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fetchData, parsePointer, sha256Hex } from "../../../tools/lib/data.ts"

const good = { buildId: "1", tag: "data-1", assets: [{ name: "a.zip", sha256: "a".repeat(64), dest: "data/x" }] }

test("committed pointer is valid", () => {
  parsePointer(JSON.parse(readFileSync(join(import.meta.dir, "../../../data/current-build.json"), "utf8")))
})

test("parsePointer rejects bad shapes and unsafe paths", () => {
  expect(() => parsePointer({})).toThrow()
  expect(() => parsePointer({ ...good, assets: [{ ...good.assets[0], sha256: "zz" }] })).toThrow()
  expect(() => parsePointer({ ...good, assets: [{ ...good.assets[0], dest: "../evil" }] })).toThrow()
  expect(() => parsePointer({ ...good, assets: [{ ...good.assets[0], name: "a/b.zip" }] })).toThrow()
})

test("fetchData verifies hash and extracts", async () => {
  const d = mkdtempSync(join(tmpdir(), "dlq-"))
  writeFileSync(join(d, "hello.txt"), "hi")
  spawnSync("zip", ["-q", "-j", join(d, "a.zip"), join(d, "hello.txt")])
  const bytes = new Uint8Array(readFileSync(join(d, "a.zip")))
  const fake = (async () => new Response(bytes)) as unknown as typeof fetch
  const ptr = parsePointer({ ...good, assets: [{ ...good.assets[0], sha256: sha256Hex(bytes) }] })
  const out = join(d, "out")
  await fetchData(ptr, out, "o/r", fake)
  expect(readFileSync(join(out, "data/x/hello.txt"), "utf8")).toBe("hi")
  await expect(fetchData(good as never, out, "o/r", fake)).rejects.toThrow(/sha256 mismatch/)
})
