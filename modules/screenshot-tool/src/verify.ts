import { ScreenshotSet, validateScreenshotSet, type Shot } from "@deadlock-query/contracts"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, normalize, sep } from "node:path"
import { imageSize } from "./image.ts"

export interface VerifyOptions {
  readonly expect?: { readonly gameBuildId?: string | undefined; readonly mapName?: string | undefined }
  readonly positionTolerance?: number | undefined
  readonly angleTolerance?: number | undefined
}

export interface VerifyReport {
  readonly ok: boolean
  /** Things that make the set untrustworthy: missing, changed or mismatching files, a pose that was not honoured. */
  readonly errors: string[]
  /** Things worth knowing that do not invalidate the set. */
  readonly warnings: string[]
  readonly info: { readonly shots: number; readonly gameBuildId?: string; readonly mapName?: string; readonly placeholder: boolean }
}

/** A file path from an index must stay inside the set folder: indexes can come from anywhere. */
export const insideDir = (dir: string, rel: string): string | undefined => {
  if (isAbsolute(rel)) return undefined
  const n = normalize(rel)
  return n === ".." || n.startsWith(`..${sep}`) || n === "." ? undefined : join(dir, n)
}

export const readSet = (dir: string): ScreenshotSet => {
  const file = join(dir, "index.json")
  if (!existsSync(file)) throw new Error(`${file} not found`)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, "utf8")) } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`) }
  const major = Number.parseInt(String((raw as { schemaVersion?: unknown } | null)?.schemaVersion), 10)
  if (major !== 1) throw new Error(`${file}: unsupported schemaVersion ${JSON.stringify((raw as { schemaVersion?: unknown } | null)?.schemaVersion)} (this tool reads 1.x)`)
  try { return Schema.decodeUnknownSync(ScreenshotSet)(raw) } catch (e) { throw new Error(`${file} is not a ScreenshotSet: ${(e as Error).message.split("\n")[0]}`) }
}

const checkShot = (dir: string, s: Shot, errors: string[], warnings: string[]): void => {
  const path = insideDir(dir, s.file)
  if (path === undefined) { errors.push(`shot "${s.id}": file path "${s.file}" leaves the set folder`); return }
  if (!existsSync(path)) errors.push(`shot "${s.id}": ${s.file} is missing`)
  else {
    const bytes = readFileSync(path)
    if (bytes.length !== s.bytes) errors.push(`shot "${s.id}": ${s.file} is ${bytes.length} bytes, the index says ${s.bytes} (changed)`)
    else if (createHash("sha256").update(bytes).digest("hex") !== s.sha256) errors.push(`shot "${s.id}": ${s.file} does not match its sha256 (tampered or corrupted)`)
    const size = imageSize(bytes)
    if (size === undefined) errors.push(`shot "${s.id}": ${s.file} is not a PNG or JPEG`)
    else if (size.width !== s.width || size.height !== s.height) errors.push(`shot "${s.id}": ${s.file} is ${size.width}x${size.height}, the index says ${s.width}x${s.height}`)
  }
  if (s.thumbnail !== undefined) {
    const t = insideDir(dir, s.thumbnail)
    if (t === undefined) errors.push(`shot "${s.id}": thumbnail path "${s.thumbnail}" leaves the set folder`)
    else if (!existsSync(t)) warnings.push(`shot "${s.id}": thumbnail ${s.thumbnail} is missing (run dlq-shoot thumbs)`)
  } else warnings.push(`shot "${s.id}": no thumbnail (run dlq-shoot thumbs)`)
  if (s.actual === undefined) warnings.push(`shot "${s.id}": pose was not read back from the game, so it is unverified`)
}

const listFiles = (dir: string, sub = ""): string[] => {
  const here = join(dir, sub)
  if (!existsSync(here)) return []
  return readdirSync(here).flatMap((n) => {
    const rel = sub ? `${sub}/${n}` : n
    return statSync(join(dir, rel)).isDirectory() ? (rel === "thumbs" ? listFiles(dir, rel) : []) : [rel]
  })
}

/**
 * Check a finished set on disk: the index is a valid `ScreenshotSet`, build and map match what the caller expects, every
 * image exists with the recorded size, sha256 and pixel size, and requested vs read-back poses agree within tolerance.
 * Never throws for a bad set; a missing or unreadable `index.json` is reported as an error.
 */
export const verifySet = (dir: string, o: VerifyOptions = {}): VerifyReport => {
  const errors: string[] = [], warnings: string[] = []
  let set: ScreenshotSet
  try { set = readSet(dir) } catch (e) {
    return { ok: false, errors: [(e as Error).message], warnings, info: { shots: 0, placeholder: false } }
  }
  errors.push(...validateScreenshotSet(set, {
    ...(o.positionTolerance !== undefined ? { positionTolerance: o.positionTolerance } : {}),
    ...(o.angleTolerance !== undefined ? { angleTolerance: o.angleTolerance } : {}),
    ...(o.expect ? { expect: Object.fromEntries(Object.entries(o.expect).filter(([, v]) => v !== undefined)) } : {})
  }))
  for (const s of set.shots) checkShot(dir, s, errors, warnings)

  const known = new Set(set.shots.flatMap((s) => [s.file, ...(s.thumbnail ? [s.thumbnail] : [])].map((f) => normalize(f).split(sep).join("/"))))
  for (const f of listFiles(dir)) {
    if (/^index\.json(l)?$/.test(f) || known.has(f)) continue
    warnings.push(`${f} is not part of the set`)
  }
  if (set.placeholder) warnings.push("placeholder set: images are not real screenshots and poses were not read from a game")
  return { ok: errors.length === 0, errors, warnings, info: { shots: set.shots.length, gameBuildId: set.gameBuildId, mapName: set.mapName, placeholder: set.placeholder === true } }
}
