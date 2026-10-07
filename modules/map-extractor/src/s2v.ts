import { ExportFailed } from "./errors.ts"

export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string }
/** Runs the Source2Viewer CLI with args; injectable so stages are testable without the tool. */
export type S2VRunner = (args: ReadonlyArray<string>) => Promise<RunResult>

export const bunRunner = (exe: string): S2VRunner => async (args) => {
  const p = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, stdout, stderr }
}

/** First meaningful line of a failed run (skips .NET stack frames). */
export const firstErrorLine = (r: RunResult): string =>
  (r.stderr + "\n" + r.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("at ") && !l.startsWith("---")) ?? `exit code ${r.code}`

/** First line that names an exception or error (e.g. `IOException: not enough space`), even on exit 0. */
export const firstExceptionLine = (r: RunResult): string | undefined =>
  (r.stderr + "\n" + r.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /exception|not enough space|no space left/i.test(l) && !l.startsWith("at "))

/** Output of the most recent run per stage, so a later missing-output check can report the real cause. */
export const lastRunOutput = new Map<string, RunResult>()

export const run = async (runner: S2VRunner, stage: string, args: string[]): Promise<RunResult> => {
  const r = await runner(args)
  lastRunOutput.set(stage, r)
  if (r.code !== 0) throw new ExportFailed({ stage, stderr: `exit ${r.code}: ${firstErrorLine(r)}` })
  return r
}

/** Argument builders, matching the commands verified in S2 (`-d` is required to export). */
export const args = {
  vpkList: (vpk: string) => ["-i", vpk, "--vpk_list"],
  /** `-o` is a file path when `-f` matches exactly one file. */
  file: (vpk: string, inner: string, out: string, extra: string[] = []) => ["-i", vpk, "-f", inner, "-o", out, "-d", ...extra],
  collision: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}/world_physics.vmdl_c`, out, ["--gltf_export_format", "glb"]),
  /**
   * `-f maps/<map>.nav` is a prefix match: with `<map>.navspace` and `<map>.navflowmap` beside it the CLI treats `-o` as a folder
   * and writes `<out>/maps/<map>.nav` (and the other two); a map with only a `.nav` gets `-o` as the file path.
   */
  nav: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}.nav`, out),
  /** Raw file (no `-d`): `.vmat_c` cannot be decompiled by this Source2Viewer build (VCS 72), but extracts fine and `dumpData` reads it. */
  raw: (vpk: string, inner: string, out: string) => ["-i", vpk, "-f", inner, "-o", out],
  /** Prints a resource's DATA block as text (KeyValues3). */
  dumpData: (file: string) => ["-i", file, "-b", "DATA"],
  /** Physics of one per-entity model (`maps/<map>/entities/<name>.vmdl`), like `collision`: written as `<out>_physics.glb`. */
  entityModel: (vpk: string, model: string, out: string) => args.file(vpk, `${model}_c`, out, ["--gltf_export_format", "glb"]),
  entities: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}/entities/default_ents.vents_c`, out),
  /**
   * `--gltf_export_materials` writes glTF materials plus their textures beside the .gltf. Opt-in: on the real dl_midtown
   * export (Source2Viewer 20.0, build 25738777) it logs shader-version exceptions (VCS 72), writes ~1.8 GB of textures, writes the
   * `.bin` files and then never writes `n0.gltf` (the process idles forever or exits without it).
   */
  render: (vpk: string, map: string, out: string, materials = false) =>
    args.file(vpk, `maps/${map}/worldnodes/n0.vwnod_c`, out, ["--gltf_export_format", "gltf", ...(materials ? ["--gltf_export_materials"] : [])])
}
