import * as THREE from "three"
import { Raycaster } from "@deadlock-query/spatial-core"
import type { Vec3 } from "@deadlock-query/contracts"

export type Triangle = readonly [Vec3, Vec3, Vec3]

export interface SurfaceHit {
  /** World-space (Z-up, Source units) hit point. */
  readonly point: Vec3
  readonly normal: Vec3
  readonly distance: number
  /** Vertices of the triangle that was hit, for vertex snapping. */
  readonly triangle: Triangle | undefined
}

/** Triangle soup in world space: `indices` are triples into the xyz-packed `positions`. */
export interface TriangleSoup {
  readonly positions: Float32Array
  readonly indices: Uint32Array
}

/** Spatial-core's `Raycaster.serialize()` header: u32 vertexCount, triCount, bvhIndexLen, rootBytes (little endian). */
const BVH_HEADER_BYTES = 16

/**
 * Triangle lookup over the geometry stored inside a serialized spatial-core BVH. `Raycaster` reports a hit's
 * `triIndex` but does not expose vertices, so the viewer reads them from the same bytes. `bvh.test.ts` checks that
 * the two stay consistent; a spatial-core accessor would replace this (see STATE.md requests).
 */
export const bakedTriangles = (bytes: Uint8Array): ((triIndex: number) => Triangle | undefined) => {
  if (bytes.byteLength < BVH_HEADER_BYTES) throw new Error("baked BVH: truncated header")
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const vertexCount = dv.getUint32(0, true), triCount = dv.getUint32(4, true)
  const need = BVH_HEADER_BYTES + vertexCount * 12 + triCount * 12
  if (bytes.byteLength < need) throw new Error("baked BVH: truncated geometry")
  // Typed-array views need 4-byte alignment; fetched buffers have it, sliced ones may not.
  const buf = bytes.byteOffset % 4 === 0 ? bytes.buffer : bytes.slice().buffer
  const base = bytes.byteOffset % 4 === 0 ? bytes.byteOffset : 0
  const pos = new Float32Array(buf, base + BVH_HEADER_BYTES, vertexCount * 3)
  const idx = new Uint32Array(buf, base + BVH_HEADER_BYTES + vertexCount * 12, triCount * 3)
  return soupTriangles({ positions: pos, indices: idx })
}

const soupTriangles = (s: TriangleSoup) => (tri: number): Triangle | undefined => {
  if (tri < 0 || (tri + 1) * 3 > s.indices.length) return undefined
  const at = (k: number): Vec3 => {
    const v = s.indices[tri * 3 + k]! * 3
    return [s.positions[v]!, s.positions[v + 1]!, s.positions[v + 2]!]
  }
  return [at(0), at(1), at(2)]
}

/** Closest surface under a ray, over the collision BVH (baked, or built from the scene's meshes). */
export class SurfacePicker {
  private constructor(
    private readonly rc: Raycaster,
    private readonly triangle: (triIndex: number) => Triangle | undefined,
    /** Where the BVH came from: shown in `data-picker` for diagnostics. */
    readonly source: "baked" | "meshes"
  ) {}

  /** From the bundle's `baked/collision.bvh` (world space, Source units). Throws on a malformed file. */
  static fromBaked(bytes: Uint8Array): SurfacePicker {
    const triangle = bakedTriangles(bytes)
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return new SurfacePicker(Raycaster.deserialize(ab), triangle, "baked")
  }

  /** Builds a BVH over `soup`; undefined when it has no triangles. */
  static fromSoup(soup: TriangleSoup, source: "baked" | "meshes" = "meshes"): SurfacePicker | undefined {
    if (soup.indices.length < 3) return undefined
    // The BVH reorders its index array in place and reports hits as indices into that order, so the triangle
    // lookup must read the same (copied, not the caller's) array afterwards.
    const indices = new Uint32Array(soup.indices)
    const rc = Raycaster.fromGeometry(soup.positions, indices)
    return new SurfacePicker(rc, soupTriangles({ positions: soup.positions, indices }), source)
  }

  /** First hit along `origin + t * dir`, either side of a triangle (collision meshes are not consistently wound). */
  raycast(origin: Vec3, dir: Vec3, max?: number): SurfaceHit | null {
    const h = this.rc.raycastFirst(origin, dir, { backfaces: true, ...(max === undefined ? {} : { max }) })
    return h ? { point: h.point, normal: h.normal, distance: h.distance, triangle: this.triangle(h.triIndex) } : null
  }
}

/** Three space (Y-up) -> world space (Z-up): (x, y, z) -> (x, -z, y). Inverse of `WORLD_TO_THREE`. */
export const threeToWorld = (x: number, y: number, z: number): Vec3 => [x, -z, y]

/** Merges meshes (their `matrixWorld` must be current) into one world-space triangle soup. */
export const worldTriangleSoup = (meshes: ReadonlyArray<THREE.Mesh>): TriangleSoup => {
  let vertices = 0, indices = 0
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position")
    if (!pos) continue
    vertices += pos.count
    indices += m.geometry.index ? m.geometry.index.count : pos.count
  }
  const positions = new Float32Array(vertices * 3)
  const out = new Uint32Array(indices - (indices % 3))
  const v = new THREE.Vector3()
  let vo = 0, io = 0
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position")
    if (!pos) continue
    const base = vo / 3
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      const w = threeToWorld(v.x, v.y, v.z)
      positions[vo++] = w[0]; positions[vo++] = w[1]; positions[vo++] = w[2]
    }
    const idx = m.geometry.index
    const n = idx ? idx.count : pos.count
    for (let i = 0; i + 2 < n && io + 2 < out.length; i += 3, io += 3) {
      out[io] = base + (idx ? idx.getX(i) : i)
      out[io + 1] = base + (idx ? idx.getX(i + 1) : i + 1)
      out[io + 2] = base + (idx ? idx.getX(i + 2) : i + 2)
    }
  }
  return { positions, indices: out.subarray(0, io) }
}
