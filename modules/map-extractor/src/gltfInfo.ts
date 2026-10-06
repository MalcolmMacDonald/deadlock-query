import { readFileSync } from "node:fs"
import type { Aabb, Mat4, Vec3 } from "@deadlock-query/contracts"
import { IDENTITY_MAT4, transformPoint } from "@deadlock-query/contracts"

interface Gltf {
  nodes?: Array<{ mesh?: number; matrix?: number[]; translation?: number[]; scale?: number[]; extras?: unknown; name?: string }>
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>
  accessors?: Array<{ min?: number[]; max?: number[]; count: number }>
}

/** JSON chunk of a `.glb`, or the whole `.gltf` text. */
export const readGltfJson = (path: string): Gltf => {
  const buf = readFileSync(path)
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const len = buf.readUInt32LE(12)
    return JSON.parse(buf.subarray(20, 20 + len).toString("utf8"))
  }
  return JSON.parse(buf.toString("utf8"))
}

export interface GltfInfo {
  readonly meshCount: number
  /** Distinct node matrices (rounded), most common first; empty array = all identity. */
  readonly nodeMatrices: ReadonlyArray<{ matrix: Mat4; count: number }>
  /** Bounds of POSITION data after node matrices (the space the file loads into). */
  readonly loadedBounds: Aabb | undefined
  /** Bounds of the raw accessor data. */
  readonly rawBounds: Aabb | undefined
  readonly triangles: number
  /** `InteractAs` tags seen in node extras. */
  readonly layers: ReadonlyArray<string>
  readonly materials: ReadonlyArray<string>
}

const nodeMatrix = (n: NonNullable<Gltf["nodes"]>[number]): Mat4 => {
  if (n.matrix?.length === 16) return n.matrix
  const t = n.translation ?? [0, 0, 0], s = n.scale ?? [1, 1, 1]
  return [s[0]!, 0, 0, 0, 0, s[1]!, 0, 0, 0, 0, s[2]!, 0, t[0]!, t[1]!, t[2]!, 1]
}

const grow = (b: { min: number[]; max: number[] } | undefined, p: Vec3) =>
  b ? { min: b.min.map((v, i) => Math.min(v, p[i]!)), max: b.max.map((v, i) => Math.max(v, p[i]!)) } : { min: [...p], max: [...p] }

export const gltfInfo = (g: Gltf): GltfInfo => {
  let loaded: { min: number[]; max: number[] } | undefined
  let raw: { min: number[]; max: number[] } | undefined
  let tris = 0
  const mats = new Map<string, { matrix: Mat4; count: number }>()
  const layers = new Set<string>()
  const materials = new Set<string>()
  for (const n of g.nodes ?? []) {
    const ia = (n.extras as { InteractAs?: unknown } | undefined)?.InteractAs
    if (Array.isArray(ia)) for (const l of ia) if (typeof l === "string") layers.add(l)
    if (n.mesh === undefined) continue
    const mesh = g.meshes?.[n.mesh]
    const mt = /_mt_(.+)$/.exec(mesh?.name ?? n.name ?? "")
    if (mt) materials.add(mt[1]!)
    const m = nodeMatrix(n)
    const key = m.map((v) => v.toPrecision(6)).join(",")
    const e = mats.get(key)
    if (e) e.count++; else mats.set(key, { matrix: m, count: 1 })
    for (const prim of mesh?.primitives ?? []) {
      const acc = g.accessors?.[prim.attributes["POSITION"] ?? -1]
      if (!acc?.min || !acc.max) continue
      tris += Math.floor((prim.indices !== undefined ? g.accessors![prim.indices]!.count : acc.count) / 3)
      for (let c = 0; c < 8; c++) {
        const p: Vec3 = [c & 1 ? acc.max[0]! : acc.min[0]!, c & 2 ? acc.max[1]! : acc.min[1]!, c & 4 ? acc.max[2]! : acc.min[2]!]
        raw = grow(raw, p)
        loaded = grow(loaded, transformPoint(m, p))
      }
    }
  }
  const sorted = [...mats.values()].sort((a, b) => b.count - a.count)
  const isId = (m: Mat4) => m.every((v, i) => Math.abs(v - IDENTITY_MAT4[i]!) < 1e-9)
  return {
    meshCount: g.meshes?.length ?? 0,
    nodeMatrices: sorted.every((s) => isId(s.matrix)) ? [] : sorted,
    loadedBounds: loaded as Aabb | undefined,
    rawBounds: raw as Aabb | undefined,
    triangles: tris,
    layers: [...layers].sort(),
    materials: [...materials].sort()
  }
}
