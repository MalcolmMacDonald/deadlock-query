// M4: dev-only modules. Prod builds omit them and never touch /auth; dev builds lock the app until DevAuth reports a session.
// Run: bun e2e/lock.ts (needs a Chromium and a prior `vite build` for the prod half; builds its own VITE_TARGET=dev copy).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright-core"
import { expectPanels, QUERY, withShell } from "./util.ts"

const PASSWORD = "correct horse"

// Prod half (the default `dist`): ?demoDevOnly is ignored and no auth request is made.
await withShell(4178, async ({ open }) => {
  const page = await open("?demoDevOnly")
  await expectPanels(page, QUERY, "prod build ignores dev-only modules")
  const authRequests = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/auth/")).length)
  if (authRequests !== 0) throw new Error(`prod build made ${authRequests} /auth request(s)`)
})

// Dev half: a build with VITE_TARGET=dev, with the dev site's /auth endpoints stubbed.
const root = join(import.meta.dir, "..")
const outDir = join(mkdtempSync(join(tmpdir(), "dlq-lock-")), "dist-dev")
const built = Bun.spawnSync(["bunx", "vite", "build", "--outDir", outDir, "--emptyOutDir"], { cwd: root, env: { ...process.env, VITE_TARGET: "dev" }, stdout: "ignore", stderr: "inherit" })
if (built.exitCode !== 0) throw new Error("dev-target build failed")

const stubAuth = (state: { authed: boolean; logins: string[] }) => async (page: Page) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill(state.authed ? { status: 200, json: { authenticated: true } } : { status: 401, json: { authenticated: false } }))
  await page.route("**/auth/login", async (route) => {
    const password = new URLSearchParams(route.request().postData() ?? "").get("password") ?? ""
    state.logins.push(password)
    if (password === PASSWORD) {
      state.authed = true
      await route.fulfill({ status: 303, headers: { location: "/" } })
    } else await route.fulfill({ status: 401, body: "Wrong password." })
  })
}

await withShell(4179, async ({ open }) => {
  const state = { authed: false, logins: [] as string[] }
  const page = await open("?demoDevOnly", { beforeLoad: stubAuth(state), waitForDock: false })
  const lock = page.getByTestId("lock-screen")
  await lock.waitFor({ timeout: 20000 })
  if (await page.evaluate(() => (globalThis as any).__dockview !== undefined)) throw new Error("the dock must not exist while locked")
  if (await page.getByText("Dev tool").count()) throw new Error("dev-only panel visible while locked")

  // Wrong password: still locked, with an error.
  await page.getByLabel("Password").fill("nope")
  await page.getByRole("button", { name: "Unlock" }).click()
  await page.getByRole("alert").getByText("Wrong password.").waitFor()
  if (state.authed) throw new Error("wrong password authenticated")

  // Right password: the dock appears with the dev-only panel next to the normal ones.
  await page.getByLabel("Password").fill(PASSWORD)
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => ((globalThis as any).__dockview?.panels.length ?? 0) > 0, null, { timeout: 20000 })
  await expectPanels(page, [...QUERY, "devonly"], "unlocked dev build")
  if (state.logins.join("|") !== `nope|${PASSWORD}`) throw new Error(`unexpected login attempts: ${state.logins}`)

  // The session persists: a reload goes straight to the app.
  await page.reload()
  await page.waitForFunction(() => ((globalThis as any).__dockview?.panels.length ?? 0) > 0, null, { timeout: 20000 })
  if (await lock.count()) throw new Error("lock screen shown despite a session")

  // Every dev build ships the reviewer panel (dev-only), so it locks even without ?demoDevOnly.
  const plain = await open("", { beforeLoad: stubAuth({ authed: false, logins: [] }), waitForDock: false })
  await plain.getByTestId("lock-screen").waitFor({ timeout: 20000 })
}, outDir)
console.log("e2e ok: prod omits dev-only modules and skips /auth; dev build locks until a session, then shows the dev-only panel")
