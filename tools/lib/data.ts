import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

export interface DataAsset { name: string; sha256: string; dest: string }
export interface DataPointer { buildId: string; tag: string; assets: DataAsset[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Validate `data/current-build.json`. Paths are confined to relative, non-escaping `dest` dirs. */
export const parsePointer = (raw: unknown): DataPointer => {
  if (!isObj(raw) || typeof raw.buildId !== "string" || typeof raw.tag !== "string" || !Array.isArray(raw.assets))
    throw new Error("current-build.json: expected { buildId, tag, assets[] }")
  const assets = raw.assets.map((a, i): DataAsset => {
    if (!isObj(a) || typeof a.name !== "string" || typeof a.sha256 !== "string" || typeof a.dest !== "string")
      throw new Error(`current-build.json: assets[${i}] needs name, sha256, dest`)
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`assets[${i}].sha256 must be 64 hex chars`)
    if (a.name.includes("/") || a.dest.startsWith("/") || a.dest.split("/").includes(".."))
      throw new Error(`assets[${i}]: unsafe name or dest`)
    return { name: a.name, sha256: a.sha256, dest: a.dest }
  })
  return { buildId: raw.buildId, tag: raw.tag, assets }
}

/** Convention checks beyond shape: tag is `data-<buildId>`, dests and names are unique. */
export const checkPointer = (p: DataPointer): string[] => {
  const errors: string[] = []
  if (p.tag !== `data-${p.buildId}`) errors.push(`tag ${p.tag} should be data-${p.buildId}`)
  if (p.assets.length === 0) errors.push("no assets listed")
  for (const key of ["name", "dest"] as const) {
    const seen = new Set<string>()
    for (const a of p.assets) {
      if (seen.has(a[key])) errors.push(`duplicate asset ${key}: ${a[key]}`)
      seen.add(a[key])
    }
  }
  return errors
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export const assetUrl = (repo: string, tag: string, name: string) =>
  `https://github.com/${repo}/releases/download/${tag}/${name}`

/** Download each asset of the pointer, verify its hash, and unzip into `<out>/<dest>`. */
export const fetchData = async (
  pointer: DataPointer,
  out: string,
  repo = process.env.GITHUB_REPOSITORY ?? "MalcolmMacDonald/deadlock-query",
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  for (const a of pointer.assets) {
    const res = await fetchFn(assetUrl(repo, pointer.tag, a.name))
    if (!res.ok) throw new Error(`download ${a.name}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const got = sha256Hex(bytes)
    if (got !== a.sha256) throw new Error(`${a.name}: sha256 mismatch (expected ${a.sha256}, got ${got})`)
    const dir = `${out}/${a.dest}`
    mkdirSync(dir, { recursive: true })
    const zip = `${dir}/.asset.zip`
    writeFileSync(zip, bytes)
    const r = spawnSync("unzip", ["-q", "-o", zip, "-d", dir])
    if (r.status !== 0) throw new Error(`unzip ${a.name} failed: ${r.stderr}`)
    spawnSync("rm", ["-f", zip])
  }
}
