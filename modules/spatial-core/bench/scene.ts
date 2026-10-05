import { BufferAttribute, BufferGeometry } from "three"

/** Deterministic synthetic scene: a jittered heightfield grid with ~`tris` triangles. */
export function makeScene(tris: number): BufferGeometry {
  const n = Math.ceil(Math.sqrt(tris / 2))
  const pos = new Float32Array((n + 1) * (n + 1) * 3)
  let seed = 1
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3
      pos[k] = i * 10; pos[k + 1] = j * 10
      pos[k + 2] = Math.sin(i * 0.05) * Math.cos(j * 0.05) * 200 + rnd() * 5
    }
  const idx = new Uint32Array(n * n * 6)
  let t = 0
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1
      idx.set([a, b, c, b, d, c], t); t += 6
    }
  const g = new BufferGeometry()
  g.setAttribute("position", new BufferAttribute(pos, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}
