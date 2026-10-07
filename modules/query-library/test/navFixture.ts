import { NavMesh, Raycaster, type NavMeshData } from "@deadlock-query/spatial-core"
import { MapContext, type NavMeshLike, type RaycasterLike } from "../src/index.ts"
import { buildMiniMap } from "@deadlock-query/contracts"

const mini = buildMiniMap()
export const floor = Raycaster.fromGeometry(
  new Float32Array([-4000, -4000, 0, 4000, -4000, 0, 4000, 4000, 0, -4000, 4000, 0]),
  new Uint32Array([0, 1, 2, 0, 2, 3])
)

/** Square cells of `S` units tiling [X0, X0+N*S] x [Y0, Y0+N*S] at z=0; poly i = ix*N+iy. */
export const S = 1000, N = 9, X0 = -4250, Y0 = -4250
export const grid = (): NavMeshData => {
  const vertices = new Float32Array((N + 1) * (N + 1) * 3)
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) vertices.set([X0 + i * S, Y0 + j * S, 0], (i * (N + 1) + j) * 3)
  const v = (i: number, j: number) => i * (N + 1) + j
  const indices = new Uint32Array(N * N * 4), offsets = new Uint32Array(N * N + 1)
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = i * N + j
    indices.set([v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)], p * 4)
    offsets[p + 1] = (p + 1) * 4
  }
  return { vertices, offsets, indices }
}
export const cell = (x: number, y: number) => [Math.floor((x - X0) / S), Math.floor((y - Y0) / S)] as const
/** Hand model: polygon-centroid hops along axes, one cell at a time. */
export const manhattan = (a: readonly number[], b: readonly number[]) => {
  if (Math.abs(a[2]!) > 1500 || Math.abs(b[2]!) > 1500) return Infinity // more than maxSnap above the mesh plane
  const [ai, aj] = cell(a[0]!, a[1]!), [bi, bj] = cell(b[0]!, b[1]!)
  return (Math.abs(ai - bi) + Math.abs(aj - bj)) * S
}


export const SPEED = 500
/** Mini-map context over the hand-computable grid navmesh (walk 500 u/s, zipline 5000 u/s). */
export const buildNavMap = (links: { from: [number, number, number]; to: [number, number, number]; kind: string }[] = []) =>
  MapContext.fromBundle({ ...mini, spatial: { raycaster: floor as RaycasterLike, nav: { mesh: NavMesh.fromPolygons(grid(), links) as NavMeshLike, heroSpeed: SPEED, linkSpeeds: { zipline: 5000 } } } })
