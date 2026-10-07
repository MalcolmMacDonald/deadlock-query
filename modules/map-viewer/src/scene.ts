import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"
import { tilesAtLod, type Mat4 } from "@deadlock-query/contracts"
import type { ViewerData } from "./ViewerPanel.ts"
import type { SurfaceKind } from "./surfaces.ts"

/** World (Z-up) -> Three (Y-up): (x,y,z) -> (x,z,-y), column-major. Mirrors contracts `Space.worldToThree`. */
export const WORLD_TO_THREE: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]

/** Matrix taking GLB-local coordinates to Three space: worldToThree * glbToWorld. */
export const glbToThreeMatrix = (glbToWorld: Mat4): THREE.Matrix4 =>
  new THREE.Matrix4().fromArray([...WORLD_TO_THREE]).multiply(new THREE.Matrix4().fromArray([...glbToWorld]))

const parseGlb = (bytes: Uint8Array): Promise<THREE.Group> => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  return new Promise((resolve, reject) => loader.parse(buf, "", (g) => resolve(g.scene), reject))
}

/**
 * Material for terrain tiles. flatShading derives normals per-fragment: extracted GLBs carry POSITION only (no
 * NORMAL), and without normals a lit material renders solid black.
 */
export const makeTerrainMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.9, side: THREE.DoubleSide, flatShading: true })

/** Visible terrain / collision meshes under a scene built by `buildScene` (entity markers excluded). */
export const surfaceMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || o.userData.marker) return
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return
    out.push(m)
  })
  return out
}

/** Shows or hides the eagerly built render tiles / collision mesh under a `buildScene` root (they carry `userData.surface`). */
export const setSurfaceVisible = (root: THREE.Object3D, kind: SurfaceKind, visible: boolean) => {
  for (const c of root.children) if (c.userData.surface === kind) c.visible = visible
}

/** Builds the Three scene root (already in Three space) from loaded viewer data. Entities are overlay layers, not part of this scene. */
export const buildScene = async (data: ViewerData): Promise<THREE.Group> => {
  const root = new THREE.Group()
  const baseMat = makeTerrainMaterial()
  // Eagerly drawn tiles are the full-resolution set: LOD tiles share their base tile's bounds and would draw over it.
  for (const tile of tilesAtLod(data.manifest, 0)) {
    const bytes = data.tiles.get(tile.id)
    if (!bytes) continue
    const group = await parseGlb(bytes)
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = baseMat })
    const holder = new THREE.Group()
    holder.matrixAutoUpdate = false
    holder.matrix.copy(glbToThreeMatrix(data.manifest.coordinateSystem.glbToWorld))
    holder.userData.surface = "render"
    holder.add(group)
    root.add(holder)
  }
  if (data.collision && data.manifest.collision) {
    const group = await parseGlb(data.collision)
    const collisionMat = new THREE.MeshStandardMaterial({ color: 0x6f8fb0, roughness: 0.9, side: THREE.DoubleSide, flatShading: true })
    const meshes: THREE.Mesh[] = []
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
    for (const m of meshes) m.material = collisionMat
    // Sky / sky-clip volumes enclose the whole map and hide everything inside; leave them out.
    const hidden = (m: THREE.Mesh) => ((m.userData.InteractAs ?? m.parent?.userData.InteractAs) as string[] | undefined)?.some((l) => l === "sky" || l === "Citadel_Skyclip") ?? false
    for (const m of meshes) m.visible = !hidden(m)
    const holder = new THREE.Group()
    holder.matrixAutoUpdate = false
    holder.matrix.copy(glbToThreeMatrix(data.manifest.collision.glbToWorld))
    holder.userData.surface = "collision"
    holder.add(group)
    root.add(holder)
  }
  root.add(new THREE.HemisphereLight(0xffffff, 0x404048, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(1, 2, 1)
  root.add(sun)
  return root
}
