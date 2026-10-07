import { expect, test } from "bun:test"
import { TEAM_BY_NAME_TOKEN, teamFromName, teamFromProperties } from "../src/teams.ts"
import { toEntities } from "../src/vents.ts"

test("team tokens map through the single table", () => {
  expect(teamFromName("boss_combine_t1_blue")).toBe(TEAM_BY_NAME_TOKEN["combine"]!)
  expect(teamFromName("combine_t2_boss_yellow")).toBe(2)
  expect(teamFromName("boss_rebel_t1_blue")).toBe(3)
  expect(teamFromName("rebels_watcher_blue")).toBe(3)
  expect(teamFromName("npc_barrack_boss_amber")).toBe(2)
  expect(teamFromName("npc_barrack_boss_sapphire")).toBe(3)
  expect(teamFromName("boss_rebellion")).toBeUndefined()
})

test("only named kinds get a team, and an explicit teamnumber wins", () => {
  expect(teamFromProperties("shop", "trigger_item_shop", { targetname: "rebel_shop" })).toBeUndefined()
  expect(teamFromProperties("barracks", "npc_barrack_boss_amber", {})).toBe(2)
  const raw = (props: Record<string, string | number>) => ({ index: 0, props, outputs: [] })
  const [a, b] = toEntities([
    raw({ classname: "info_super_trooper_spawn", bossname: "boss_rebel_t1_blue", hammeruniqueid: "1" }),
    raw({ classname: "npc_boss_tier2", bossname: "combine_t2_boss_yellow", teamnumber: 3, hammeruniqueid: "2" })
  ])
  expect(a!.team).toBe(3)
  expect(b!.team).toBe(3)
})

test("spawns and base sentries inherit the team of the nearest teamed entity in their base", () => {
  const raw = (id: string, props: Record<string, string | number>, origin: number[]) => ({ index: Number(id), props: { ...props, origin, hammeruniqueid: id }, outputs: [] })
  const out = toEntities([
    raw("1", { classname: "npc_barrack_boss", subclass_name: "npc_barrack_boss_amber" }, [1000, 9000, 1200]),
    raw("2", { classname: "npc_barrack_boss", subclass_name: "npc_barrack_boss_sapphire" }, [-1000, -9000, 1200]),
    raw("3", { classname: "info_team_spawn" }, [1200, 10200, 1218]),
    raw("4", { classname: "npc_base_defense_sentry" }, [-900, -9400, 1152]),
    raw("5", { classname: "info_team_spawn" }, [6136, 0, 1737])
  ])
  const team = (id: string) => out.find((e) => e.id === id)!.team
  expect(team("3")).toBe(2)
  expect(team("4")).toBe(3)
  expect(team("5")).toBeUndefined() // mid-map, nothing near
})
