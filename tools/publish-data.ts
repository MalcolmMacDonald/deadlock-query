import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { parsePointer, sha256Hex } from "./lib/data.ts"
import { writeZip } from "./lib/zip.ts"
import { checkBundleReady } from "../modules/infra/src/bundleReady.ts"
import { assetName, bundleFiles, checkBundleBudget, parseBundleManifest, releaseTag, updatePointer } from "./lib/publish.ts"

const USAGE = `bun tools/publish-data.ts <bundle-dir> [--upload [--skip-existing]]
  Checks the bundle is tiled and baked and its files match the manifest, zips it (without .work, .stage-* and the raw
  game nav files), writes the sha256 into data/current-build.json, and with --upload adds the zip to the GitHub Release
  data-<buildId> via gh (created on first use; the asset name carries the hash, so earlier assets are never overwritten;
  --skip-existing does not upload again when the Release already has an asset of that name).
  Then open a PR ([infra] title prefix) with the pointer change.`

const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.error}`)
  return r.stdout
}

if (import.meta.main) {
  const dir = process.argv[2] && !process.argv[2].startsWith("--") ? resolve(process.argv[2]) : undefined
  if (!dir) { console.error(USAGE); process.exit(1) }
  const upload = process.argv.includes("--upload")
  const info = parseBundleManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")))
  const files = bundleFiles(dir)
  const problems = [...(await checkBundleReady(dir, files)), ...checkBundleBudget(dir, files)]
  if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join("\n")); process.exit(2) }

  const tmp = join(dirname(dir), `${info.mapName}-${info.buildId}-${info.tier}.tmp.zip`)
  rmSync(tmp, { force: true })
  writeZip(tmp, dir, files) // paths relative to the bundle root, so manifest.json is at the zip root
  const sha = sha256Hex(new Uint8Array(readFileSync(tmp)))
  const zip = join(dirname(dir), assetName(info, sha))
  rmSync(zip, { force: true })
  renameSync(tmp, zip)
  console.log(`zip: ${zip}\nsha256: ${sha}`)

  const pointerPath = "data/current-build.json"
  const prev = existsSync(pointerPath) ? parsePointer(JSON.parse(readFileSync(pointerPath, "utf8"))) : undefined
  writeFileSync(pointerPath, JSON.stringify(updatePointer(prev, info, sha), null, 2) + "\n")
  console.log(`updated ${pointerPath}`)

  const tag = releaseTag(info)
  if (upload) {
    const exists = spawnSync("gh", ["release", "view", tag], { stdio: "ignore" }).status === 0
    if (!exists) run("gh", ["release", "create", tag, "--title", tag, "--notes", `Derived ${info.tier} map data for game build ${info.buildId}. See docs/takedown.md.`])
    const name = basename(zip)
    const have = process.argv.includes("--skip-existing") && run("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"]).split("\n").includes(name)
    if (have) console.log(`release ${tag} already has ${name}; not uploading again`)
    else {
      run("gh", ["release", "upload", tag, zip, "--clobber"])
      console.log(`uploaded to release ${tag}`)
    }
  } else {
    console.log(`next: gh release create ${tag} --title ${tag} --notes "..." && gh release upload ${tag} ${zip} --clobber   (or rerun with --upload)`)
  }
  console.log("then: commit data/current-build.json on a branch and open a PR with an [infra] title; merging redeploys the dev site (prod moves on the next promote).")
}
