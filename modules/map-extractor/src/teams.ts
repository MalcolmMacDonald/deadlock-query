import type { EntityKind } from "@deadlock-query/contracts"

/**
 * Team numbers derived from names, because the real dl_midtown entities carry no `teamnumber`.
 *
 * The map's boss names say `rebel` or `combine` (`boss_rebel_t1_blue`, `combine_t2_boss_yellow`) and the barracks say `amber`
 * or `sapphire` (`npc_barrack_boss_amber`). Which of them is team 2 or 3 is NOT verified: this table is the single place to
 * change it. Default: Source's two playing teams are 2 and 3, Amber (Hidden King) is 2 and Sapphire (Archmother) is 3, and
 * the names are paired combine = Amber, rebel = Sapphire. Flagged in STATE.md for Malcolm to confirm.
 */
export const TEAM_BY_NAME_TOKEN: Readonly<Record<string, number>> = {
  amber: 2,
  combine: 2,
  sapphire: 3,
  rebel: 3
}

/** Kinds whose name carries a team (spawns, shops and the like are neutral or shared). */
const NAMED_TEAM_KINDS: ReadonlySet<EntityKind> = new Set(["guardian", "walker", "patron", "barracks", "baseSentry"])

const NAME_KEYS = ["bossname", "subclass_name", "targetname", "classname"] as const
const TOKEN = new RegExp(`(?:^|[^a-z])(${Object.keys(TEAM_BY_NAME_TOKEN).join("|")})s?(?![a-z])`, "i")

/** Team in a name such as `boss_rebel_t1_blue` or `npc_barrack_boss_amber`; undefined when no token matches. */
export const teamFromName = (name: string): number | undefined => {
  const m = TOKEN.exec(name)
  return m ? TEAM_BY_NAME_TOKEN[m[1]!.toLowerCase()] : undefined
}

export const teamFromProperties = (kind: EntityKind | undefined, cls: string, props: Readonly<Record<string, unknown>>): number | undefined => {
  if (!kind || !NAMED_TEAM_KINDS.has(kind)) return undefined
  for (const v of [...NAME_KEYS.map((k) => props[k]), cls]) {
    const t = typeof v === "string" ? teamFromName(v) : undefined
    if (t !== undefined) return t
  }
  return undefined
}

/** Kinds that carry no team name of their own but sit inside one base (the real map gives them no `teamnumber` either). */
const BASE_KINDS: ReadonlySet<EntityKind> = new Set(["spawn", "baseSentry"])
/** A base entity inherits the team of the nearest teamed entity within this horizontal distance and height difference. */
export const BASE_TEAM_RADIUS = 2500
export const BASE_TEAM_MAX_DZ = 300

/** Gives spawns and base sentries the team of the nearest named-team entity (barracks, patron, ...) in their base. */
export const inheritBaseTeams = <E extends { kind?: EntityKind; team?: number; position: readonly [number, number, number] }>(entities: ReadonlyArray<E>): E[] => {
  const teamed = entities.filter((e) => e.team !== undefined)
  return entities.map((e) => {
    if (e.team !== undefined || !e.kind || !BASE_KINDS.has(e.kind)) return e
    let best: E | undefined, bestD = BASE_TEAM_RADIUS
    for (const t of teamed) {
      if (Math.abs(t.position[2] - e.position[2]) > BASE_TEAM_MAX_DZ) continue
      const d = Math.hypot(t.position[0] - e.position[0], t.position[1] - e.position[1])
      if (d <= bestD) { bestD = d; best = t }
    }
    return best ? { ...e, team: best.team } : e
  })
}
