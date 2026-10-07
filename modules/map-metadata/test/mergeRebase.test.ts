import { expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyMetadataBundle, type MetadataBundle, type MetadataRecord } from "@deadlock-query/contracts"
import { checkDocument, rebaseRecords } from "../src/index.ts"

const root = join(import.meta.dir, "..")
const manifest = join(root, "../contracts/fixtures/mini-map/manifest.json")
const run = (script: string, ...args: string[]) => {
  const p = Bun.spawnSync(["bun", `scripts/${script}.ts`, ...args], { cwd: root })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}
const tmpBuild = (name = "0") => { const base = mkdtempSync(join(tmpdir(), "md-")); const dir = join(base, name); cpSync(join(root, "fixtures/valid/0"), dir, { recursive: true }); return { base, dir } }

test("metadata:merge writes a valid, hash-verified bundle and is byte-stable", () => {
  const { base, dir } = tmpBuild()
  try {
    expect(run("merge", dir).code).toBe(0)
    const text = readFileSync(join(dir, "metadata.bundle.json"), "utf8")
    expect(checkDocument(text, {}, { as: "bundle" }).ok).toBe(true)
    const b = JSON.parse(text) as MetadataBundle
    expect(verifyMetadataBundle(b)).toBe(true)
    const kinds = b.records.map((r) => r.kind)
    expect(kinds).toEqual([...kinds].sort())
    expect(run("merge", dir).code).toBe(0)
    expect(readFileSync(join(dir, "metadata.bundle.json"), "utf8")).toBe(text)
    expect(run("merge", dir, "--check").code).toBe(0)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("metadata:merge --check fails when a kind file changed after the bundle was built, and on invalid data", () => {
  const { base, dir } = tmpBuild()
  try {
    run("merge", dir)
    const f = join(dir, "creepCamp.json")
    const doc = JSON.parse(readFileSync(f, "utf8")); doc.records[0].name = "renamed"
    writeFileSync(f, JSON.stringify(doc, null, 2))
    const stale = run("merge", dir, "--check")
    expect(stale.code).toBe(1)
    expect(stale.out).toContain("stale")
    doc.records.push({ ...doc.records[0] })   // duplicate id
    writeFileSync(f, JSON.stringify(doc, null, 2))
    expect(run("merge", dir).code).toBe(1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("merge with no directory is a usage error", () => { expect(run("merge").code).toBe(2) })

const camp = (id: string, x: number, status: MetadataRecord["status"] = "accepted"): MetadataRecord => ({ id, kind: "creepCamp", status, provenance: {}, position: [x, 0, 0] })
const bounds = { min: [-1000, -1000, -100], max: [1000, 1000, 500] } as const

test("rebaseRecords keeps what fits, marks the rest stale with a reason, drops proposed and rejected", () => {
  const r = rebaseRecords([camp("in", 0), camp("out", 5000), camp("p", 0, "proposed"), camp("r", 0, "rejected")], { bounds: bounds as never })
  expect(r.records.map((x) => [x.id, x.status])).toEqual([["in", "accepted"], ["out", "stale"]])
  expect(r.stale[0]!.reason).toContain("outside the map bounds")
  expect(r.kept).toBe(1)
  expect(r.degraded).toBe(true)
})

test("a stale record that fits again is re-accepted and loses its stale comment", () => {
  const stale: MetadataRecord = { ...camp("back", 0, "stale"), provenance: { comment: "old reason" } }
  const r = rebaseRecords([stale], { bounds: bounds as never })
  expect(r.records[0]).toMatchObject({ status: "accepted", provenance: {} })
})

test("metadata:rebase writes the new build's files and exits 1 when something went stale", () => {
  const { base, dir } = tmpBuild("0")
  try {
    const small = JSON.parse(readFileSync(manifest, "utf8"))
    small.gameBuildId = "1"; small.bounds = { min: [-1200, -1200, -100], max: [1200, 1200, 500] }
    const mf = join(base, "manifest.json"); writeFileSync(mf, JSON.stringify(small))
    const res = run("rebase", "--from", dir, "--manifest", mf)
    expect(res.code).toBe(1)
    expect(res.out).toContain("stale")
    const out = join(base, "1")
    expect(existsSync(join(out, "creepCamp.json"))).toBe(true)
    const doc = JSON.parse(readFileSync(join(out, "creepCamp.json"), "utf8"))
    expect(doc.gameBuildId).toBe("1")
    expect(checkDocument(readFileSync(join(out, "creepCamp.json"), "utf8"), {}, { as: "file", fileName: "creepCamp.json" }).ok).toBe(true)
    // Generous bounds: nothing stale, exit 0, and --dry-run writes nothing.
    small.bounds = { min: [-9e4, -9e4, -9e3], max: [9e4, 9e4, 9e3] }; small.gameBuildId = "2"
    writeFileSync(mf, JSON.stringify(small))
    expect(run("rebase", "--from", dir, "--manifest", mf, "--dry-run").code).toBe(0)
    expect(existsSync(join(base, "2"))).toBe(false)
    expect(run("rebase", "--from", dir, "--manifest", mf).code).toBe(0)
    expect(existsSync(join(base, "2", "creepCamp.json"))).toBe(true)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("rebase refuses a different map", () => {
  const { base, dir } = tmpBuild()
  try {
    const other = JSON.parse(readFileSync(manifest, "utf8")); other.mapName = "dl_other"
    const mf = join(base, "m.json"); writeFileSync(mf, JSON.stringify(other))
    expect(run("rebase", "--from", dir, "--manifest", mf).code).toBe(2)
    expect(run("rebase").code).toBe(2)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
