// M5: theming, About panel, error toasts, and keyboard-only panel operation. Run: bun e2e/polish.ts (needs a prior `vite build`).
import type { Page } from "playwright-core"
import { expectPanels, QUERY, withShell } from "./util.ts"

const active = (page: Page) => page.evaluate(() => (globalThis as any).__dockview.activePanel?.id as string | undefined)
const theme = (page: Page) => page.locator("html").getAttribute("data-theme")

await withShell(4183, async ({ open }) => {
  const page = await open()

  // Theme: dark by default, the header button and the palette command toggle it, and the choice survives a reload.
  if ((await theme(page)) !== "dark") throw new Error(`default theme should be dark, got ${await theme(page)}`)
  await page.getByTestId("toggle-theme").click()
  if ((await theme(page)) !== "light") throw new Error("header button should switch to light")
  if (!(await page.locator(".dockview-theme-light").count())) throw new Error("dockview should follow the light theme")
  await page.reload()
  await page.waitForFunction(() => ((globalThis as any).__dockview?.panels.length ?? 0) > 0)
  if ((await theme(page)) !== "light") throw new Error("theme did not persist")
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Type a command" }).fill("theme")
  await page.keyboard.press("Enter")
  if ((await theme(page)) !== "dark") throw new Error("palette command should switch back to dark")

  // About: build info, game build and library API version (or the fallbacks), reopenable from the palette after closing.
  await page.getByTestId("open-about").click()
  const about = page.getByTestId("about-panel")
  await about.waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-testid="about-panel"]')?.textContent?.includes("loading…"))
  const sha = (await page.getByTestId("about-sha").textContent()) ?? ""
  if (!/\b[0-9a-f]{7}\b|unknown/.test(sha) || !sha.includes("prod")) throw new Error(`unexpected build line: ${sha}`)
  if (!(await page.getByTestId("about-game-build").textContent())?.trim()) throw new Error("game build id missing")
  if (!(await page.getByTestId("about-api-version").textContent())?.trim()) throw new Error("API version line missing")
  if (!(await page.getByTestId("about-shortcuts").textContent())?.includes("Ctrl+K")) throw new Error("shortcut list missing Ctrl+K")
  await page.evaluate(() => (globalThis as any).__dockview.getPanel("shell.about").api.close())
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Type a command" }).fill("about")
  await page.keyboard.press("Enter")
  await about.waitFor()

  // Toasts: an uncaught rejection raises an assertive error toast; repeats collapse; the button dismisses it.
  const toasts = page.getByTestId("toast")
  const boom = () => page.evaluate(() => { setTimeout(() => void Promise.reject(new Error("e2e boom"))) })
  await boom()
  await toasts.getByText("Unexpected error: e2e boom").waitFor()
  if ((await toasts.first().getAttribute("role")) !== "alert") throw new Error("error toasts must be role=alert")
  await boom()
  await toasts.getByText("(×2)").waitFor()
  if ((await toasts.count()) !== 1) throw new Error("identical toasts should collapse")
  await page.getByRole("button", { name: "Dismiss notification" }).focus()
  await page.keyboard.press("Enter")
  await toasts.waitFor({ state: "detached" })

  // Keyboard only: cycle focus, maximize, close and reopen panels, without touching the mouse.
  await page.getByTestId("preset-query").click()
  await expectPanels(page, QUERY, "Query preset before keyboard run")
  const first = await active(page)
  await page.keyboard.press("Alt+.")
  const second = await active(page)
  if (!second || second === first) throw new Error(`Alt+. should move focus to the next panel (still ${second})`)
  await page.keyboard.press("Alt+,")
  if ((await active(page)) !== first) throw new Error("Alt+, should return to the previous panel")
  await page.keyboard.press("Alt+Shift+M")
  if (!(await page.evaluate(() => (globalThis as any).__dockview.activePanel.api.isMaximized()))) throw new Error("Alt+Shift+M should maximize")
  await page.keyboard.press("Alt+Shift+M")
  if (await page.evaluate(() => (globalThis as any).__dockview.activePanel.api.isMaximized())) throw new Error("Alt+Shift+M again should restore")
  const closed = await active(page)
  const closedTitle = await page.evaluate(() => (globalThis as any).__dockview.activePanel.title as string)
  await page.keyboard.press("Alt+Shift+W")
  await toasts.getByText("Reopen it from the command palette").waitFor()
  if ((await page.evaluate((id) => Boolean((globalThis as any).__dockview.getPanel(id)), closed))) throw new Error("Alt+Shift+W should close the active panel")
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Type a command" }).fill(`show panel ${closedTitle}`)
  await page.keyboard.press("Enter")
  await expectPanels(page, QUERY, "closed panel reopened from the palette")

  // Moving between groups by keyboard.
  const groupsBefore = await page.evaluate(() => (globalThis as any).__dockview.groups.length as number)
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Type a command" }).fill("next group")
  await page.keyboard.press("Enter")
  const groupsAfter = await page.evaluate(() => (globalThis as any).__dockview.groups.length as number)
  if (groupsAfter >= groupsBefore) throw new Error(`moving a panel into the next group should merge groups (${groupsBefore} -> ${groupsAfter})`)
  console.log("e2e ok: theme toggles and persists, About shows build info, error toasts collapse and dismiss, panels operate by keyboard alone")
})
