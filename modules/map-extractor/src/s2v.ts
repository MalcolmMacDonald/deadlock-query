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

export const run = async (runner: S2VRunner, stage: string, args: string[]): Promise<RunResult> => {
  const r = await runner(args)
  if (r.code !== 0) throw new ExportFailed({ stage, stderr: `exit ${r.code}: ${firstErrorLine(r)}` })
  return r
}

/** Argument builders, matching the commands verified in S2 (`-d` is required to export). */
export const args = {
  vpkList: (vpk: string) => ["-i", vpk, "--vpk_list"],
  /** `-o` is a file path when `-f` matches exactly one file. */
  file: (vpk: string, inner: string, out: string, extra: string[] = []) => ["-i", vpk, "-f", inner, "-o", out, "-d", ...extra],
  collision: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}/world_physics.vmdl_c`, out, ["--gltf_export_format", "glb"]),
  entities: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}/entities/default_ents.vents_c`, out),
  render: (vpk: string, map: string, out: string) => args.file(vpk, `maps/${map}/worldnodes/n0.vwnod_c`, out, ["--gltf_export_format", "gltf"])
}
