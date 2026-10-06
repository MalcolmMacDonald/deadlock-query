import { Manifest, type Vec3 } from "@deadlock-query/contracts"
import { Schema } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { EXIT } from "./errors.ts"
import { DEFAULT_FOV, DEFAULT_RESOLUTION, gridPlan, parsePlan, PlanError, ringPlan, serializePlan, type PlanMeta, type ShotPlan } from "./plan.ts"

export const PLAN_USAGE = `dlq-shoot plan <generator> [options]   (prints the plan JSON, or writes it with --out)
  common     [--map <name>] [--build <gameBuildId>] [--bundle <dir>] [--fov ${DEFAULT_FOV}] [--resolution ${DEFAULT_RESOLUTION.width}x${DEFAULT_RESOLUTION.height}] [--show-hud] [--out <file>]
             --bundle takes the map name, build id and (for grid) the xy bounds from <dir>/manifest.json
  grid       --z <height> --spacing <units> [--bounds minX,minY,maxX,maxY] [--yaws 4] [--pitch 0]
  ring       --at x,y,z [--at x,y,z ...] [--yaws 8] [--pitch 0]
  from-file  <plan.json>   validate and rewrite in canonical form`

const nums = (s: string, n: number, what: string): number[] => {
  const v = s.split(",").map((x) => Number(x.trim()))
  if (v.length !== n || v.some((x) => !Number.isFinite(x) || x.toString() === "")) throw new PlanError([`${what} must be ${n} comma-separated numbers, got "${s}"`])
  return v
}
const num = (s: string | undefined, fallback: number | undefined, what: string): number | undefined => {
  if (s === undefined) return fallback
  const v = Number(s)
  if (s.trim() === "" || !Number.isFinite(v)) throw new PlanError([`${what} must be a number, got "${s}"`])
  return v
}

export const planMain = (argv: ReadonlyArray<string>, write: (text: string) => void = (t) => process.stdout.write(t)): number => {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        map: { type: "string" }, build: { type: "string" }, bundle: { type: "string" }, out: { type: "string" },
        fov: { type: "string" }, resolution: { type: "string" }, "show-hud": { type: "boolean" },
        bounds: { type: "string" }, spacing: { type: "string" }, z: { type: "string" }, yaws: { type: "string" }, pitch: { type: "string" },
        at: { type: "string", multiple: true }
      }
    })
    const [generator, file] = positionals
    if (generator !== "grid" && generator !== "ring" && generator !== "from-file") {
      console.error(PLAN_USAGE)
      return generator === undefined ? EXIT.ok : EXIT.usage
    }

    let plan: ShotPlan
    if (generator === "from-file") {
      if (!file) { console.error(PLAN_USAGE); return EXIT.usage }
      let raw: unknown
      try { raw = JSON.parse(readFileSync(file, "utf8")) } catch (e) { throw new PlanError([`cannot read ${file}: ${(e as Error).message}`]) }
      plan = parsePlan(raw)
    } else {
      let manifest: Manifest | undefined
      if (values.bundle) {
        try { manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(join(values.bundle, "manifest.json"), "utf8"))) }
        catch (e) { throw new PlanError([`cannot read a bundle manifest in ${values.bundle}: ${(e as Error).message.split("\n")[0]}`]) }
      }
      const map = values.map ?? manifest?.mapName
      if (!map) throw new PlanError(["pass --map <name> or --bundle <dir>"])
      let resolution: PlanMeta["resolution"] = DEFAULT_RESOLUTION
      if (values.resolution !== undefined) {
        const m = /^(\d+)x(\d+)$/.exec(values.resolution)
        if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new PlanError([`resolution must look like 1920x1080, got "${values.resolution}"`])
        resolution = { width: Number(m[1]), height: Number(m[2]) }
      }
      const meta: PlanMeta = { map, gameBuildId: values.build ?? manifest?.gameBuildId, resolution, fov: num(values.fov, DEFAULT_FOV, "fov")!, hideHud: !values["show-hud"] }
      const yaws = num(values.yaws, undefined, "yaws")
      const pitch = num(values.pitch, undefined, "pitch")
      if (generator === "ring") {
        if (!values.at || values.at.length === 0) throw new PlanError(["ring needs at least one --at x,y,z"])
        plan = ringPlan(meta, { at: values.at.map((a) => nums(a, 3, "--at") as unknown as Vec3), ...(yaws !== undefined ? { yaws } : {}), ...(pitch !== undefined ? { pitch } : {}) })
      } else {
        const b = values.bounds ? nums(values.bounds, 4, "--bounds") : manifest ? [manifest.bounds.min[0], manifest.bounds.min[1], manifest.bounds.max[0], manifest.bounds.max[1]] : undefined
        if (!b) throw new PlanError(["grid needs --bounds minX,minY,maxX,maxY or --bundle <dir>"])
        const spacing = num(values.spacing, undefined, "spacing")
        const z = num(values.z, undefined, "z")
        if (spacing === undefined || z === undefined) throw new PlanError(["grid needs --spacing <units> and --z <camera height>"])
        plan = gridPlan(meta, { bounds: b as unknown as [number, number, number, number], spacing, z, ...(yaws !== undefined ? { yaws } : {}), ...(pitch !== undefined ? { pitch } : {}) })
      }
    }
    const text = serializePlan(plan)
    if (values.out) { writeFileSync(values.out, text); console.error(`wrote ${plan.shots.length} shots to ${values.out}`) } else write(text)
    return EXIT.ok
  } catch (e) {
    if (e instanceof PlanError) { console.error(e.problems.map((p) => `✗ ${p}`).join("\n")); return EXIT.problem }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) { console.error(`${(e as Error).message}\n${PLAN_USAGE}`); return EXIT.usage }
    throw e
  }
}
