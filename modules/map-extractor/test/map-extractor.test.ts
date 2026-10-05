import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doctor } from "../src/doctor.ts"
import { GameNotFound } from "../src/errors.ts"
import { buildIdFromManifest, libraryPaths, listMaps, locateGame } from "../src/steam.ts"
import { parseVersion } from "../src/tool.ts"
import { parseVdf } from "../src/vdf.ts"

const LIBS = `"libraryfolders"
{
  "0" { "path" "C:\\\\Steam" "apps" { "228980" "1" } }
  "1" { "path" "D:\\\\Games" "apps" { "1422450" "123" } }
}`

test("vdf parses nested blocks and escapes", () => {
  expect(parseVdf(`"a" { "b" "c\\\\d" // x\n "e" { "f" "g" } }`)).toEqual({ a: { b: "c\\d", e: { f: "g" } } })
  expect(() => parseVdf(`"a" {`)).toThrow()
})

test("libraryfolders finds the library holding the app", () => {
  expect(libraryPaths(LIBS)).toEqual([{ path: "C:\\Steam", hasApp: false }, { path: "D:\\Games", hasApp: true }])
})

test("appmanifest build id", () => {
  expect(buildIdFromManifest(`"AppState" { "appid" "1422450" "buildid" "25712201" }`)).toBe("25712201")
})

const fakeSteam = () => {
  const steam = mkdtempSync(join(tmpdir(), "dlq-steam-"))
  const sa = join(steam, "steamapps")
  const root = join(sa, "common", "Deadlock")
  mkdirSync(join(root, "game", "citadel", "maps"), { recursive: true })
  writeFileSync(join(root, "game", "citadel", "gameinfo.gi"), "")
  for (const m of ["dl_midtown", "dl_hideout", "start"]) writeFileSync(join(root, "game", "citadel", "maps", `${m}.vpk`), "")
  writeFileSync(join(sa, "libraryfolders.vdf"), `"libraryfolders" { "0" { "path" ${JSON.stringify(steam)} "apps" { "1422450" "1" } } }`)
  writeFileSync(join(sa, "appmanifest_1422450.acf"), `"AppState" { "buildid" "25712201" }`)
  return { steam, root }
}

test("locateGame via steam library, list-maps filters non-gameplay", () => {
  const { steam, root } = fakeSteam()
  const g = locateGame({ steamRoots: [steam], env: {} })
  expect(g.root).toBe(root)
  expect(g.buildId).toBe("25712201")
  expect(listMaps(g)).toEqual(["dl_hideout", "dl_midtown"])
})

test("locateGame honours DEADLOCK_DIR and reports bad explicit paths", () => {
  const { root } = fakeSteam()
  expect(locateGame({ env: { DEADLOCK_DIR: root }, steamRoots: [] }).source).toBe("DEADLOCK_DIR")
  expect(() => locateGame({ gameDir: "/nope", steamRoots: [] })).toThrow(GameNotFound)
  expect(() => locateGame({ steamRoots: ["/nope"], env: {} })).toThrow(GameNotFound)
})

test("doctor is helpful on failure and passes on a good setup", () => {
  const bad = doctor({ gameDir: "/nope", run: () => "" })
  expect(bad.ok).toBe(false)
  expect(bad.checks.find((c) => c.name === "game")?.fix).toContain("--game-dir")
  expect(parseVersion("Source 2 Viewer CLI 20.0.1234")).toBe("20.0.1234")
})
