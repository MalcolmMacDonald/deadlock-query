import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import lock from "../tools.lock.json" with { type: "json" }
import { ToolMissing } from "./errors.ts"

export const pinned = lock["source2viewer-cli"]
const exe = process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI"

export interface ToolStatus {
  readonly path: string
  readonly version: string | undefined
  readonly pinnedVersion: string
  readonly matchesPin: boolean
}

export const candidatePaths = (env: Record<string, string | undefined> = process.env): string[] => {
  const home = env["USERPROFILE"] ?? env["HOME"] ?? ""
  return [env["S2V_CLI"], join(home, "tools", "s2v", exe)].filter((p): p is string => !!p)
}

/** Parse the version out of `Source2Viewer-CLI --version` output (e.g. "Source 2 Viewer 20.0 ..."). */
export const parseVersion = (out: string): string | undefined => /(\d+\.\d+(?:\.\d+)*)/.exec(out)?.[1]

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex")

export const findTool = (env?: Record<string, string | undefined>, run: (path: string) => string = defaultRun): ToolStatus => {
  const tried = candidatePaths(env)
  const path = tried.find((p) => existsSync(p))
  if (!path) {
    throw new ToolMissing({
      tool: "Source2Viewer-CLI",
      remediation: `Not found (looked in ${tried.join(", ") || "S2V_CLI unset"}). Download ${pinned.version} from ${pinned["windows-x64"].url} (sha256 ${pinned["windows-x64"].sha256}), unzip it, and set S2V_CLI to ${exe}.`
    })
  }
  const version = parseVersion(run(path))
  return { path, version, pinnedVersion: pinned.version, matchesPin: version === pinned.version }
}

function defaultRun(path: string): string {
  const r = Bun.spawnSync([path, "--version"])
  return r.stdout.toString() + r.stderr.toString()
}
