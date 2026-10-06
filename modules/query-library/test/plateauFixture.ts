import { Raycaster } from "@deadlock-query/spatial-core"
import { buildMiniMap } from "@deadlock-query/contracts"
import { MapContext, type RaycasterLike, type SemanticsLike } from "../src/index.ts"

const mini = buildMiniMap()

/** Floor at z=0 over +-4000 plus a 2000x2000 plateau at z=1000 centred on the origin (height 1000). */
export const plateau = Raycaster.fromGeometry(
  new Float32Array([
    -4000, -4000, 0, 4000, -4000, 0, 4000, 4000, 0, -4000, 4000, 0,
    -1000, -1000, 1000, 1000, -1000, 1000, 1000, 1000, 1000, -1000, 1000, 1000,
  ]),
  new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
)

/** Hand-computable stub: a point sees another when they are less than 1500 units apart in XY. */
export const nearSemantics: SemanticsLike = {
  placeholder: true,
  isInterior: () => false,
  isVisible: (_rc, a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1500,
  nearestWall: () => null,
}

export const buildPlateauMap = () =>
  MapContext.fromBundle({ ...mini, spatial: { raycaster: plateau as RaycasterLike, semantics: nearSemantics } })
