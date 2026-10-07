// M3: layout presets and reset. Run: bun e2e/presets.ts (needs a Chromium and a prior `vite build`).
import { EXPLORE, expectPanels, QUERY, withShell } from "./util.ts"

await withShell(4175, async ({ open }) => {
  const page = await open()
  await expectPanels(page, QUERY, "default preset")
  // The metadata editor is a Review panel: it must not leak into the default layout.
  if (!(await page.getByTestId("preset-review").count())) throw new Error("Review preset missing although the metadata editor is registered")

  await page.getByTestId("preset-explore").click()
  await expectPanels(page, EXPLORE, "Explore preset")

  // The chosen layout persists across a reload.
  await page.reload()
  await expectPanels(page, EXPLORE, "Explore after reload")

  await page.getByTestId("preset-review").click()
  await expectPanels(page, [...EXPLORE, "metadata.editor", "metadata.history"], "Review preset")

  await page.getByTestId("preset-query").click()
  await expectPanels(page, QUERY, "Query preset")

  // Reset returns to the default preset after panels were closed.
  await page.evaluate(() => {
    const api = (globalThis as any).__dockview
    api.getPanel("viewer.layers").api.close()
    api.getPanel("query.editor").api.close()
  })
  await expectPanels(page, ["viewer.inspector", "viewer.main", "viewer.tools"], "after closing panels")
  await page.getByTestId("reset-layout").click()
  await expectPanels(page, QUERY, "after reset")
  await page.reload()
  await expectPanels(page, QUERY, "reset layout after reload")
  console.log("e2e ok: Explore/Query presets apply and persist, Reset restores the default after closing panels")
})
