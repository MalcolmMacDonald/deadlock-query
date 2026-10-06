import { ScreenshotSet } from "@deadlock-query/contracts"
import { Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { EXIT } from "./errors.ts"
import { DEFAULT_THUMB_EDGE, makeThumbnail, thumbFile } from "./thumbs.ts"
import { insideDir, readSet, verifySet } from "./verify.ts"

export const SET_USAGE = `dlq-shoot verify <set-dir> [--build <id>] [--map <name>] [--position-tolerance 8] [--angle-tolerance 1] [--json]
             check index.json, every image (exists, size, sha256, pixel size), poses and build/map; exit 2 if anything is wrong
dlq-shoot thumbs <set-dir> [--size ${DEFAULT_THUMB_EDGE}] [--force]
             make missing JPEG thumbnails (--force: all of them) and record them in index.json`

const num = (s: string | undefined, what: string): number | undefined => {
  if (s === undefined) return undefined
  const v = Number(s)
  if (s.trim() === "" || !Number.isFinite(v) || v <= 0) throw new RangeError(`${what} must be a positive number, got "${s}"`)
  return v
}

export const setMain = (cmd: "verify" | "thumbs", argv: ReadonlyArray<string>): number => {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        build: { type: "string" }, map: { type: "string" }, "position-tolerance": { type: "string" }, "angle-tolerance": { type: "string" },
        json: { type: "boolean" }, size: { type: "string" }, force: { type: "boolean" }
      }
    })
    const [dir] = positionals
    if (!dir) { console.error(SET_USAGE); return EXIT.usage }

    if (cmd === "verify") {
      const r = verifySet(dir, {
        expect: { gameBuildId: values.build, mapName: values.map },
        positionTolerance: num(values["position-tolerance"], "position-tolerance"),
        angleTolerance: num(values["angle-tolerance"], "angle-tolerance")
      })
      if (values.json) console.log(JSON.stringify(r, null, 2))
      else {
        for (const e of r.errors) console.log(`✗ ${e}`)
        for (const w of r.warnings) console.log(`! ${w}`)
        console.log(r.ok ? `verify ok: ${r.info.shots} shots` : `verify failed: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}`)
      }
      return r.ok ? EXIT.ok : EXIT.problem
    }

    const edge = num(values.size, "size") ?? DEFAULT_THUMB_EDGE
    let set: ScreenshotSet
    try { set = readSet(dir) } catch (e) { console.error(`✗ ${(e as Error).message}`); return EXIT.problem }
    let made = 0, failed = 0
    const shots = set.shots.map((s) => {
      const img = insideDir(dir, s.file)
      const existing = s.thumbnail !== undefined ? insideDir(dir, s.thumbnail) : undefined
      if (!values.force && existing !== undefined && existsSync(existing)) return s
      if (img === undefined || !existsSync(img)) { console.error(`! ${s.id}: image missing, no thumbnail`); failed++; return s }
      const thumb = makeThumbnail(readFileSync(img), edge)
      if (thumb === undefined) { console.error(`! ${s.id}: image not decodable, no thumbnail`); failed++; return s }
      const rel = thumbFile(s.id)
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), thumb)
      made++
      return { ...s, thumbnail: rel }
    })
    writeFileSync(join(dir, "index.json"), `${JSON.stringify(Schema.encodeSync(ScreenshotSet)({ ...set, shots }), null, 2)}\n`)
    console.log(`made ${made} thumbnail${made === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}`)
    return failed > 0 ? EXIT.problem : EXIT.ok
  } catch (e) {
    if (e instanceof RangeError) { console.error(`✗ ${e.message}`); return EXIT.usage }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) { console.error(`${(e as Error).message}\n${SET_USAGE}`); return EXIT.usage }
    throw e
  }
}
