import { expect, test } from "bun:test"
import { laneFromName, laneFromTint } from "../src/lanes.ts"
import { parseVents, toEntities } from "../src/vents.ts"

test("lane colour in boss names: the game's purple lane is Green", () => {
  expect(laneFromName("boss_rebel_t1_yellow")).toBe("yellow")
  expect(laneFromName("combine_t2_boss_blue")).toBe("blue")
  expect(laneFromName("[PR#]combine_t2_boss_purple")).toBe("green")
  expect(laneFromName("rebels_watcher_blue")).toBe("blue")
  expect(laneFromName("boss_combine_tier2_mid")).toBeUndefined()
  expect(laneFromName("npc_barrack_boss_amber")).toBeUndefined()
})

test("zipline tints from the real map classify as Yellow, Blue and Green; white has no lane", () => {
  expect(laneFromTint([255, 106, 0])).toBe("yellow")
  expect(laneFromTint([0, 25, 255])).toBe("blue")
  expect(laneFromTint([139, 0, 139])).toBe("green")
  expect(laneFromTint([255, 255, 255])).toBeUndefined()
  expect(laneFromTint([0, 0, 0])).toBeUndefined()
  expect(laneFromTint("[0, 25, 255]")).toBeUndefined()
})

const VENTS = `
====0====
classname  "info_super_trooper_spawn"
bossname  "boss_rebel_t1_purple"
origin  [ 7040, -1984, 256 ]
====1====
classname  "npc_boss_tier2"
bossname  "rebels_t2_boss_blue"
targetname  "[PR#]rebels_t2_boss_blue"
origin  [ -1288, -3472, 376 ]
====2====
classname  "npc_boss_tier2"
bossname  "combine_t2_boss_yellow"
lanenum  3
origin  [ 0, 0, 0 ]
====3====
classname  "npc_boss_tier3"
bossname  "boss_combine_tier2_mid"
origin  [ 1280, 8048, 632 ]
====4====
classname  "citadel_zipline_path"
hammeruniqueid  "8785:623"
color_tint  [ 139, 0, 139 ]
use_baselane_color  0
====5====
classname  "citadel_zipline_path_node"
hammeruniqueid  "8785:624"
path_uniqueid  "8785:623"
path_index  1
origin  [ 5, 0, 0 ]
====6====
classname  "citadel_zipline_path_node"
hammeruniqueid  "8785:625"
path_uniqueid  "8785:999"
path_index  0
origin  [ 6, 0, 0 ]
====7====
classname  "citadel_zipline_path"
hammeruniqueid  "8785:1000"
color_tint  [ 255, 106, 0 ]
use_baselane_color  1
====8====
classname  "citadel_zipline_path_node"
hammeruniqueid  "8785:1001"
path_uniqueid  "8785:1000"
origin  [ 7, 0, 0 ]
`

test("lane is derived from names and zipline path tints, never overriding lanenum", () => {
  const es = toEntities(parseVents(VENTS))
  expect(es.map((e) => e.lane)).toEqual([3, 2, 3, undefined, undefined, 3, undefined, undefined, undefined])
  expect(es[5]!.kind).toBe("zipline")
})

test("a multi-line quoted pathnodes value is one number list, not junk keys", () => {
  const es = toEntities(parseVents(`
====0====
classname  "lane_marker_path"
laneslot  3
pathnodes  "
[
0.0, 0.0, -4.0, 549.0,
-328.0244, -240.0, 0.0, 430.0,
1e-3, 7, 8, 9
]"
hammeruniqueid  "14836:807"
====1====
classname  "citadel_zipline_path"
pathnodes  "[  ]"
====2====
classname  "lane_marker_path"
pathnodes  "
1, 2, 3,
====3====
classname  "info_team_spawn"
`))
  expect(es).toHaveLength(4)
  expect(es[0]!.properties["pathnodes"]).toEqual([0, 0, -4, 549, -328.0244, -240, 0, 430, 0.001, 7, 8, 9])
  expect(es[0]!.properties["hammeruniqueid"]).toBe("14836:807")
  expect(Object.keys(es[0]!.properties).some((k) => k.endsWith(","))).toBe(false)
  expect(es[1]!.properties["pathnodes"]).toBe("[  ]")
  expect(es[2]!.properties["pathnodes"]).toEqual([1, 2, 3]) // unterminated: ends with its entity
  expect(es[3]!.class).toBe("info_team_spawn")
})
