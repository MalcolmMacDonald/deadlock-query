import { parseKv3 } from "./kv3.ts"

/**
 * Reader for the game's own navigation mesh, `maps/<map>.nav` (Source 2 `0xFEEDFACE` nav file, version 36 in build 25738777).
 *
 * Reverse-engineered from `dl_midtown.nav` (no public spec; Source2Viewer only copies the file). What is decoded:
 *
 *   u32  magic 0xFEEDFACE
 *   u32  version (36 = 0x24)
 *   u32  0, u32 flags (0x01000001 seen)           (meaning unknown)
 *   KV3  an empty binary KeyValues3 v5 block, uncompressed (`KV3\x05` + 120 byte header + a 9 byte payload ending 00 DD EE FF)
 *   u32  vertexCount
 *   f32  x, y, z * vertexCount                      world position, Source units, Z up, same frame as entities
 *   u32  faceCount
 *   face * faceCount: u8 n (3 or 4 seen), u32 vertexIndex * n, u32 0xFFFFFFFF
 *
 * Faces are the convex walkable polygons (wound consistently, vertices pooled: about a third of the pool repeats the same position
 * and must be welded before the faces share edges). After the faces comes a second empty KV3 block and a per-face record stream
 * (`u32 faceId` starting at 1, then flags and small lists, 62 to 82 bytes each, not decoded; the `.navflowmap` `nav_id`s are those
 * 1-based face ids). Nothing after the face list is needed for geometry, so it is only reported (`restOffset`).
 */

export class NavFileError extends Error {
  readonly _tag = "NavFileError"
  constructor(message: string) { super(message) }
}

export interface NavFile {
  readonly version: number
  /** xyz triples, Source units, Z up (not welded). */
  readonly vertices: Float32Array
  /** One entry per face: vertex indices into `vertices`, in winding order. */
  readonly faces: ReadonlyArray<ReadonlyArray<number>>
  /** Offset of the first byte after the face list (start of the undecoded per-face data). */
  readonly restOffset: number
}

export const NAV_MAGIC = 0xfeedface

/** Parses the vertex pool and the face list; throws `NavFileError` on anything that does not match what was observed. */
export const parseNavFile = (bytes: Uint8Array): NavFile => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const need = (o: number, n: number, what: string) => {
    if (o < 0 || o + n > bytes.byteLength) throw new NavFileError(`nav file truncated while reading ${what}`)
  }
  need(0, 0x10, "header")
  if (dv.getUint32(0, true) !== NAV_MAGIC) throw new NavFileError("not a Source 2 nav file (bad magic)")
  const version = dv.getUint32(4, true)

  // The leading KV3 block (observed empty): only its length matters.
  let o: number
  try { o = parseKv3(bytes, 0x10).end } catch (e) { throw new NavFileError(`unsupported nav layout: ${e instanceof Error ? e.message : String(e)}`) }
  need(o, 4, "vertex count")

  const vertexCount = dv.getUint32(o, true)
  o += 4
  need(o, vertexCount * 12, "vertices")
  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) vertices[i] = dv.getFloat32(o + i * 4, true)
  o += vertexCount * 12

  need(o, 4, "face count")
  const faceCount = dv.getUint32(o, true)
  o += 4
  const faces: number[][] = new Array(faceCount)
  for (let f = 0; f < faceCount; f++) {
    need(o, 1, `face ${f}`)
    const n = bytes[o]!
    o += 1
    if (n < 3 || n > 16) throw new NavFileError(`face ${f} has ${n} vertices (expected 3 to 16): unsupported nav layout`)
    need(o, n * 4 + 4, `face ${f}`)
    const face = new Array<number>(n)
    for (let k = 0; k < n; k++) {
      const v = dv.getUint32(o + k * 4, true)
      if (v >= vertexCount) throw new NavFileError(`face ${f} references vertex ${v} of ${vertexCount}`)
      face[k] = v
    }
    faces[f] = face
    o += n * 4 + 4 // trailing u32 (0xFFFFFFFF in every face seen)
  }
  return { version, vertices, faces, restOffset: o }
}
