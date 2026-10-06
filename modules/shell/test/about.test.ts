import { expect, test } from "bun:test"
import { loadAboutData } from "../src/about.tsx"
import { buildInfo } from "../src/buildInfo.ts"

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body }) as Response
const routes = (table: Record<string, Response>): typeof fetch =>
  (async (url: URL | string) => table[new URL(String(url)).pathname.split("/").slice(-2).join("/")] ?? json({}, false)) as unknown as typeof fetch

test("about reads the game build from the published manifest and the API version from library.json", async () => {
  const data = await loadAboutData(
    routes({
      "dl_midtown/manifest.json": json({ mapName: "dl_midtown", gameBuildId: "25738777" }),
      "editor/library.json": json({ apiVersion: "0.3.0" }),
    }),
    "https://site.test/app/",
  )
  expect(data).toEqual({ mapSource: "bundle", mapName: "dl_midtown", gameBuildId: "25738777", libraryApiVersion: "0.3.0" })
})

test("about falls back to the fixture manifest and reports a missing library as unavailable", async () => {
  const data = await loadAboutData(routes({}), "https://site.test/app/")
  expect(data.mapSource).toBe("fixture")
  expect(data.mapName.length).toBeGreaterThan(0)
  expect(data.gameBuildId.length).toBeGreaterThan(0)
  expect(data.libraryApiVersion).toBeNull()
})

test("build info has a target and falls back to unknown outside a Vite build", () => {
  expect(["dev", "prod"]).toContain(buildInfo.target)
  expect(buildInfo.gitSha).toBe("unknown")
})
