import { Box3, BufferAttribute, BufferGeometry, Ray, Sphere, Vector3, FrontSide, DoubleSide, Line3, Triangle } from "three"
import { MeshBVH } from "three-mesh-bvh"
import type { Aabb, Vec3 } from "@deadlock-query/contracts"

export interface Hit { readonly point: Vec3; readonly normal: Vec3; readonly distance: number; readonly triIndex: number }
export interface ClosestPoint { readonly point: Vec3; readonly normal: Vec3; readonly distance: number; readonly triIndex: number }
export interface RayOpts { readonly max?: number; readonly backfaces?: boolean; readonly signal?: AbortSignal; readonly onProgress?: (done: number, total: number) => void }
export interface SphereShape { readonly center: Vec3; readonly radius: number }
export interface CapsuleShape { readonly a: Vec3; readonly b: Vec3; readonly radius: number }

/** Backend-agnostic static-geometry queries (PLAN §3). */
export interface Raycaster {
  readonly bounds: Aabb
  readonly triangleCount: number
  /** Corner positions of triangle `triIndex` (the index reported in `Hit`/`ClosestPoint`); throws RangeError when out of range. */
  triangle(triIndex: number): readonly [Vec3, Vec3, Vec3]
  raycastFirst(origin: Vec3, dir: Vec3, opts?: RayOpts): Hit | null
  raycastAll(origin: Vec3, dir: Vec3, opts?: RayOpts): Hit[]
  /** True when a triangle blocks the segment a→b. */
  occluded(a: Vec3, b: Vec3): boolean
  closestPoint(p: Vec3, opts?: { maxDist?: number }): ClosestPoint | null
  overlapsSphere(s: SphereShape): boolean
  overlapsCapsule(c: CapsuleShape): boolean
  /** Writes hit distance (or -1 for a miss) per ray; origins/dirs are packed xyz. */
  raycastFirstMany(origins: Float32Array, dirs: Float32Array, opts?: RayOpts): Float32Array
  serialize(): ArrayBuffer
}

const v3 = (v: Vec3) => new Vector3(v[0], v[1], v[2])
const tup = (v: Vector3): Vec3 => [v.x, v.y, v.z]

class BvhRaycaster implements Raycaster {
  readonly bounds: Aabb
  readonly triangleCount: number
  constructor(private readonly geo: BufferGeometry, private readonly bvh: MeshBVH) {
    const b = bvh.getBoundingBox(new Box3())
    this.bounds = { min: tup(b.min), max: tup(b.max) }
    this.triangleCount = geo.index!.count / 3
  }

  triangle(triIndex: number): readonly [Vec3, Vec3, Vec3] {
    if (!Number.isInteger(triIndex) || triIndex < 0 || triIndex >= this.triangleCount) throw new RangeError(`triangle ${triIndex} out of range 0..${this.triangleCount - 1}`)
    const idx = this.geo.index!, pos = this.geo.getAttribute("position")
    const at = (k: number): Vec3 => { const v = idx.getX(triIndex * 3 + k); return [pos.getX(v), pos.getY(v), pos.getZ(v)] }
    return [at(0), at(1), at(2)]
  }

  private hit(h: { point: Vector3; distance: number; faceIndex?: number | null | undefined; face?: { normal: Vector3 } | null | undefined }): Hit {
    return { point: tup(h.point), normal: h.face ? tup(h.face.normal) : [0, 0, 1], distance: h.distance, triIndex: h.faceIndex ?? -1 }
  }

  private ray(origin: Vec3, dir: Vec3): Ray {
    return new Ray(v3(origin), v3(dir).normalize())
  }

  raycastFirst(origin: Vec3, dir: Vec3, opts: RayOpts = {}): Hit | null {
    const h = this.bvh.raycastFirst(this.ray(origin, dir), opts.backfaces ? DoubleSide : FrontSide, 0, opts.max ?? Infinity)
    return h ? this.hit(h) : null
  }

  raycastAll(origin: Vec3, dir: Vec3, opts: RayOpts = {}): Hit[] {
    const hs = this.bvh.raycast(this.ray(origin, dir), opts.backfaces ? DoubleSide : FrontSide, 0, opts.max ?? Infinity)
    return hs.map((h) => this.hit(h)).sort((x, y) => x.distance - y.distance)
  }

  occluded(a: Vec3, b: Vec3): boolean {
    const d = v3(b).sub(v3(a))
    const len = d.length()
    if (len === 0) return false
    return this.bvh.raycastFirst(new Ray(v3(a), d.divideScalar(len)), DoubleSide, 0, len) !== null
  }

  closestPoint(p: Vec3, opts: { maxDist?: number } = {}): ClosestPoint | null {
    const r = this.bvh.closestPointToPoint(v3(p), undefined, 0, opts.maxDist ?? Infinity)
    if (!r || r.distance > (opts.maxDist ?? Infinity)) return null
    const idx = this.geo.index!, pos = this.geo.getAttribute("position")
    const tri = new Triangle().setFromAttributeAndIndices(pos as BufferAttribute, idx.getX(r.faceIndex * 3), idx.getX(r.faceIndex * 3 + 1), idx.getX(r.faceIndex * 3 + 2))
    return { point: tup(r.point), normal: tup(tri.getNormal(new Vector3())), distance: r.distance, triIndex: r.faceIndex }
  }

  overlapsSphere(s: SphereShape): boolean {
    return this.bvh.intersectsSphere(new Sphere(v3(s.center), s.radius))
  }

  overlapsCapsule(c: CapsuleShape): boolean {
    const seg = new Line3(v3(c.a), v3(c.b))
    const box = new Box3().setFromPoints([seg.start, seg.end]).expandByScalar(c.radius)
    const tp = new Vector3(), sp = new Vector3()
    return this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => tri.closestPointToSegment(seg, tp, sp) < c.radius,
    })
  }

  raycastFirstMany(origins: Float32Array, dirs: Float32Array, opts: RayOpts = {}): Float32Array {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const n = origins.length / 3
    const out = new Float32Array(n)
    const ray = new Ray()
    const side = opts.backfaces ? DoubleSide : FrontSide
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
      ray.origin.fromArray(origins, i * 3)
      ray.direction.fromArray(dirs, i * 3).normalize()
      const h = this.bvh.raycastFirst(ray, side, 0, opts.max ?? Infinity)
      out[i] = h ? h.distance : -1
      if (opts.onProgress) opts.onProgress(i + 1, n)
    }
    return out
  }

  /**
   * Layout: u32 vertexCount, triCount, indexLen, rootBytes; f32 positions; u32 indices;
   * u32 BVH index; BVH root. Geometry is included so `deserialize` is self-contained.
   */
  serialize(): ArrayBuffer {
    const pos = this.geo.getAttribute("position").array as Float32Array
    const idx = this.geo.index!.array as Uint32Array
    const data = MeshBVH.serialize(this.bvh, { cloneBuffers: false })
    if (data.roots.length !== 1) throw new Error("multi-root BVH not supported")
    const root = data.roots[0]!, bvhIndex = data.index as Uint32Array
    const buf = new ArrayBuffer(HEAD + pos.byteLength + idx.byteLength + bvhIndex.byteLength + root.byteLength)
    const dv = new DataView(buf)
    dv.setUint32(0, pos.length / 3, true)
    dv.setUint32(4, idx.length / 3, true)
    dv.setUint32(8, bvhIndex.length, true)
    dv.setUint32(12, root.byteLength, true)
    let o = HEAD
    new Float32Array(buf, o, pos.length).set(pos); o += pos.byteLength
    new Uint32Array(buf, o, idx.length).set(idx); o += idx.byteLength
    new Uint32Array(buf, o, bvhIndex.length).set(bvhIndex); o += bvhIndex.byteLength
    new Uint8Array(buf, o, root.byteLength).set(new Uint8Array(root))
    return buf
  }
}

const HEAD = 16

const toGeometry = (positions: Float32Array, indices: Uint32Array): BufferGeometry => {
  const g = new BufferGeometry()
  g.setAttribute("position", new BufferAttribute(positions, 3))
  g.setIndex(new BufferAttribute(indices, 1))
  return g
}

export const Raycaster = {
  fromGeometry(positions: Float32Array, indices: Uint32Array): Raycaster {
    const geo = toGeometry(positions, indices)
    // MeshBVH reorders geometry.index in place; keep that so serialise is self-consistent.
    return new BvhRaycaster(geo, new MeshBVH(geo, { maxLeafTris: 10 }))
  },
  deserialize(bytes: ArrayBuffer): Raycaster {
    const dv = new DataView(bytes)
    const vc = dv.getUint32(0, true), tc = dv.getUint32(4, true), ic = dv.getUint32(8, true), rb = dv.getUint32(12, true)
    let o = HEAD
    const pos = new Float32Array(bytes.slice(o, o + vc * 12)); o += vc * 12
    const idx = new Uint32Array(bytes.slice(o, o + tc * 12)); o += tc * 12
    const index = new Uint32Array(bytes.slice(o, o + ic * 4)); o += ic * 4
    const root = bytes.slice(o, o + rb)
    const geo = toGeometry(pos, idx)
    return new BvhRaycaster(geo, MeshBVH.deserialize({ roots: [root], index } as never, geo, { setIndex: false }))
  },
}
