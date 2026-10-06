import { expect, test } from "bun:test"
import { PLACEHOLDER_SEMANTICS, Raycaster, isInterior, isVisible, nearestWall } from "../../src/index.ts"
import cases from "./cases.json"

/** Floor [0,1000]² at z=0 plus a closed 200-unit room at x,y in [200,400], roof at z=200. */
function scene(): Raycaster {
  const v: number[] = [], idx: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const i = v.length / 3
    v.push(...a, ...b, ...c, ...d)
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3)
  }
  quad([0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0])
  quad([200, 200, 0], [400, 200, 0], [400, 200, 200], [200, 200, 200])
  quad([200, 400, 0], [400, 400, 0], [400, 400, 200], [200, 400, 200])
  quad([200, 200, 0], [200, 400, 0], [200, 400, 200], [200, 200, 200])
  quad([400, 200, 0], [400, 400, 0], [400, 400, 200], [400, 200, 200])
  quad([200, 200, 200], [400, 200, 200], [400, 400, 200], [200, 400, 200])
  return Raycaster.fromGeometry(new Float32Array(v), new Uint32Array(idx))
}

test("semantics are flagged as placeholders", () => expect(PLACEHOLDER_SEMANTICS).toBe(true))

test("labelled cases (unlabelled ones are reported, not failed)", () => {
  const rc = scene()
  const unlabelled: string[] = []
  for (const c of cases.cases as { name: string; fn: string; args: any; expected: any }[]) {
    let got: unknown
    if (c.fn === "isInterior") got = isInterior(rc, c.args.p, c.args.opts)
    else if (c.fn === "isVisible") got = isVisible(rc, c.args.from, c.args.to, c.args.opts)
    else got = nearestWall(rc, c.args.p, c.args.opts)
    if (c.expected === null && c.fn !== "nearestWall") { unlabelled.push(c.name); continue }
    if (c.fn === "nearestWall" && c.expected !== null) expect((got as { distance: number }).distance).toBeCloseTo(c.expected.distance, 3)
    else expect(got).toEqual(c.expected)
  }
  console.log(`semantics harness: ${cases.cases.length - unlabelled.length} labelled, ${unlabelled.length} unlabelled (${unlabelled.join(", ")})`)
})
