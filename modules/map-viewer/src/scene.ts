import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import type { Mat4 } from "@deadlock-query/contracts"
import type { ViewerData } from "./ViewerPanel.ts"

/** World (Z-up) -> Three (Y-up): (x,y,z) -> (x,z,-y), column-major. Mirrors contracts `Space.worldToThree`. */
export const WORLD_TO_THREE: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]

/** Matrix taking GLB-local coordinates to Three space: worldToThree * glbToWorld. */
export const glbToThreeMatrix = (glbToWorld: Mat4): THREE.Matrix4 =>
  new THREE.Matrix4().fromArray([...WORLD_TO_THREE]).multiply(new THREE.Matrix4().fromArray([...glbToWorld]))

const parseGlb = (bytes: Uint8Array): Promise<THREE.Group> => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Promise((resolve, reject) => new GLTFLoader().parse(buf, "", (g) => resolve(g.scene), reject))
}

const ENTITY_COLORS: Record<string, number> = { guardian: 0xe8a33d, walker: 0xd45d5d, patron: 0xb04fd0, creepCamp: 0x4fb36b }

/** Builds the Three scene root (already in Three space) from loaded viewer data. */
export const buildScene = async (data: ViewerData): Promise<THREE.Group> => {
  const root = new THREE.Group()
  // flatShading derives normals per-fragment: extracted GLBs carry POSITION only (no NORMAL), and without
  // normals a lit material renders solid black.
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.9, side: THREE.DoubleSide, flatShading: true })
  for (const tile of data.manifest.tiles) {
    const bytes = data.tiles.get(tile.id)
    if (!bytes) continue
    const group = await parseGlb(bytes)
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = baseMat })
    const holder = new THREE.Group()
    holder.matrixAutoUpdate = false
    holder.matrix.copy(glbToThreeMatrix(data.manifest.coordinateSystem.glbToWorld))
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
    holder.add(group)
    root.add(holder)
  }
  const geo = new THREE.SphereGeometry(40, 12, 8)
  for (const e of data.entities) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: ENTITY_COLORS[e.kind ?? ""] ?? 0x8a8f98 }))
    m.position.set(e.position[0], e.position[2], -e.position[1])
    root.add(m)
  }
  root.add(new THREE.HemisphereLight(0xffffff, 0x404048, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 1.5)
  sun.position.set(1, 2, 1)
  root.add(sun)
  return root
}
