// M5: axe-core accessibility audit of the shell in both themes (dock, open palette, About panel, toast).
// Needs a Chromium and a prior `vite build`. Run: bun e2e/a11y.ts
import type { Page } from "playwright-core"
import { withShell } from "./util.ts"

const axePath = Bun.resolveSync("axe-core/axe.min.js", import.meta.dir)

interface Violation { id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; html: string }> }

const audit = async (page: Page, what: string): Promise<Violation[]> => {
  await page.addScriptTag({ path: axePath })
  const violations = (await page.evaluate(async () => (await (globalThis as any).axe.run(document)).violations)) as Violation[]
  for (const v of violations) console.log(`  [${what}] ${v.impact} ${v.id}: ${v.help}\n${v.nodes.slice(0, 4).map((n) => `      ${JSON.stringify(n.target)} ${n.html.slice(0, 110)}`).join("\n")}`)
  return violations
}

await withShell(4181, async ({ open }) => {
  const page = await open()
  await page.getByTestId("open-about").click()
  await page.getByTestId("about-panel").waitFor()
  await page.evaluate(() => { setTimeout(() => void Promise.reject(new Error("audit toast"))) })
  await page.getByTestId("toast").waitFor()
  const all: Violation[] = []
  for (const theme of ["dark", "light"] as const) {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) await page.getByTestId("toggle-theme").click()
    all.push(...(await audit(page, `${theme} dock`)))
    await page.keyboard.press("Control+k")
    await page.getByRole("dialog", { name: "Command palette" }).waitFor()
    all.push(...(await audit(page, `${theme} palette`)))
    await page.keyboard.press("Escape")
  }
  if (all.length) throw new Error(`${all.length} accessibility violation(s): ${[...new Set(all.map((v) => v.id))].join(", ")}`)
  console.log("e2e ok: axe reports no violations in the dark and light themes (dock, About, toast, palette)")
})
