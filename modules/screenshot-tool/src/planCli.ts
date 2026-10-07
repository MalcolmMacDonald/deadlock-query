import type { Manifest, Vec3 } from "@deadlock-query/contracts"
import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { EXIT } from "./errors.ts"
import { loadBundle } from "./occlusion.ts"
import { DEFAULT_FOV, DEFAULT_RESOLUTION, gridPlanWithFloor, parsePlan, PlanError, ringPlan, serializePlan, type PlanMeta, type ShotPlan } from "./plan.ts"
import { standoffPlan, type Occlusion, targetsFromAnnotations, targetsFromMetadata, type Extracted } from "./targets.ts"

export const PLAN_USAGE = `dlq-shoot plan <generator> [options]   (prints the plan JSON, or writes it with --out)
  common     [--map <name>] [--build <gameBuildId>] [--bundle <dir>] [--fov ${DEFAULT_FOV}] [--resolution ${DEFAULT_RESOLUTION.width}x${DEFAULT_RESOLUTION.height}] [--show-hud] [--out <file>]
             --bundle takes the map name, build id and (for grid) the xy bounds from <dir>/manifest.json
  grid       (--z <height> | --above-floor <height> [--z <reference height>]) --spacing <units> [--bounds minX,minY,maxX,maxY] [--yaws 4] [--pitch 0]
  ring       --at x,y,z [--at x,y,z ...] [--yaws 8] [--pitch 0]
  from-file  <plan.json>   validate and rewrite in canonical form
  from-annotations  <annotations.json> [--layer <id>]   look at each point/label annotation from several sides
  from-metadata     <metadata.bundle.json> [--all-status]   same for accepted creep camps, Sinner's Sacrifice, healing orbs (--all-status adds proposed ones)
             both: [--standoffs 3] [--distance 600] [--eye-height 64] [--bearing-offset 0]; map and build id come from the file unless --map/--build/--bundle say otherwise;
             --bundle also keeps cameras inside the map bounds and, if the bundle has a baked collision BVH, drops or moves cameras whose view of the target is blocked (--no-los skips that);
             without a baked bundle line of sight is not checked`

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
        bounds: { type: "string" }, "above-floor": { type: "string" }, spacing: { type: "string" }, z: { type: "string" }, yaws: { type: "string" }, pitch: { type: "string" },
        at: { type: "string", multiple: true },
        layer: { type: "string" }, "all-status": { type: "boolean" }, "no-los": { type: "boolean" }, standoffs: { type: "string" }, distance: { type: "string" }, "eye-height": { type: "string" }, "bearing-offset": { type: "string" }
      }
    })
    const [generator, file] = positionals
    if (generator !== "grid" && generator !== "ring" && generator !== "from-file" && generator !== "from-annotations" && generator !== "from-metadata") {
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
      let extracted: Extracted | undefined
      if (generator === "from-annotations" || generator === "from-metadata") {
        if (!file) { console.error(PLAN_USAGE); return EXIT.usage }
        let raw: unknown
        try { raw = JSON.parse(readFileSync(file, "utf8")) } catch (e) { throw new PlanError([`cannot read ${file}: ${(e as Error).message}`]) }
        extracted = generator === "from-annotations" ? targetsFromAnnotations(raw, { layer: values.layer }) : targetsFromMetadata(raw, { allStatuses: values["all-status"] === true })
      }
      let manifest: Manifest | undefined
      let occlusion: Occlusion | undefined
      let floorAt: ReturnType<typeof loadBundle>["floorAt"]
      if (values.bundle) {
        const b = loadBundle(values.bundle)
        manifest = b.manifest
        floorAt = b.floorAt
        if (extracted !== undefined && values["no-los"] !== true) {
          occlusion = b.occlusion
          if (occlusion === undefined) console.error(`! ${values.bundle} has no baked collision (run dlq-extract bake): lines of sight are not checked`)
        }
      }
      const map = values.map ?? extracted?.mapName ?? manifest?.mapName
      if (!map) throw new PlanError(["pass --map <name> or --bundle <dir>"])
      let resolution: PlanMeta["resolution"] = DEFAULT_RESOLUTION
      if (values.resolution !== undefined) {
        const m = /^(\d+)x(\d+)$/.exec(values.resolution)
        if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new PlanError([`resolution must look like 1920x1080, got "${values.resolution}"`])
        resolution = { width: Number(m[1]), height: Number(m[2]) }
      }
      const meta: PlanMeta = { map, gameBuildId: values.build ?? extracted?.gameBuildId ?? manifest?.gameBuildId, resolution, fov: num(values.fov, DEFAULT_FOV, "fov")!, hideHud: !values["show-hud"] }
      const yaws = num(values.yaws, undefined, "yaws")
      const pitch = num(values.pitch, undefined, "pitch")
      if (extracted !== undefined) {
        const standoffs = num(values.standoffs, undefined, "standoffs")
        const distance = num(values.distance, undefined, "distance")
        const eyeHeight = num(values["eye-height"], undefined, "eye-height")
        const bearingOffset = num(values["bearing-offset"], undefined, "bearing-offset")
        const r = standoffPlan(meta, extracted.targets, {
          ...(standoffs !== undefined ? { standoffs } : {}), ...(distance !== undefined ? { distance } : {}),
          ...(eyeHeight !== undefined ? { eyeHeight } : {}), ...(bearingOffset !== undefined ? { bearingOffset } : {}),
          ...(manifest ? { bounds: manifest.bounds } : {}), ...(occlusion ? { occlusion } : {})
        })
        for (const sk of [...extracted.skipped, ...r.skipped]) console.error(`! skipped ${sk.id}: ${sk.reason}`)
        for (const w of r.warnings) console.error(`! ${w}`)
        plan = r.plan
      } else if (generator === "ring") {
        if (!values.at || values.at.length === 0) throw new PlanError(["ring needs at least one --at x,y,z"])
        plan = ringPlan(meta, { at: values.at.map((a) => nums(a, 3, "--at") as unknown as Vec3), ...(yaws !== undefined ? { yaws } : {}), ...(pitch !== undefined ? { pitch } : {}) })
      } else {
        const b = values.bounds ? nums(values.bounds, 4, "--bounds") : manifest ? [manifest.bounds.min[0], manifest.bounds.min[1], manifest.bounds.max[0], manifest.bounds.max[1]] : undefined
        if (!b) throw new PlanError(["grid needs --bounds minX,minY,maxX,maxY or --bundle <dir>"])
        const aboveFloor = num(values["above-floor"], undefined, "above-floor")
        const spacing = num(values.spacing, undefined, "spacing")
        let z = num(values.z, undefined, "z")
        if (spacing === undefined) throw new PlanError(["grid needs --spacing <units> and --z <camera height> (or --above-floor <height>)"])
        let floor: Parameters<typeof gridPlanWithFloor>[1]["aboveFloor"]
        if (aboveFloor !== undefined) {
          if (!floorAt) throw new PlanError(["--above-floor needs --bundle <dir> with a baked navmesh (run `dlq-extract bake`)"])
          // Without --z, prefer the floor nearest the middle of the map's height range.
          z ??= manifest ? (manifest.bounds.min[2] + manifest.bounds.max[2]) / 2 : 0
          floor = { height: aboveFloor, reach: spacing, floorAt }
        } else if (z === undefined) throw new PlanError(["grid needs --spacing <units> and --z <camera height> (or --above-floor <height>)"])
        const r = gridPlanWithFloor(meta, { bounds: b as unknown as [number, number, number, number], spacing, z: z!, ...(floor ? { aboveFloor: floor } : {}), ...(yaws !== undefined ? { yaws } : {}), ...(pitch !== undefined ? { pitch } : {}) })
        if (r.dropped > 0) console.error(`! dropped ${r.dropped} grid cells with no walkable floor within ${spacing} units`)
        plan = r.plan
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
