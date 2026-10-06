// M3: command palette (Ctrl+K): open, filter, reopen a closed panel, switch preset, keyboard-only. Run: bun e2e/palette.ts
import { EXPLORE, expectPanels, QUERY, withShell } from "./util.ts"

await withShell(4176, async ({ open }) => {
  const page = await open()
  const dialog = page.getByRole("dialog", { name: "Command palette" })
  const input = page.getByRole("combobox", { name: "Type a command" })

  await page.keyboard.press("Control+k")
  await dialog.waitFor()
  if (!(await input.evaluate((el) => el === document.activeElement))) throw new Error("palette input should have focus")
  await page.keyboard.press("Control+k")
  await dialog.waitFor({ state: "hidden" })

  // Close a panel, then reopen it from the palette with the keyboard only.
  await page.evaluate(() => (globalThis as any).__dockview.getPanel("viewer.layers").api.close())
  await expectPanels(page, ["query.editor", "viewer.inspector", "viewer.main", "viewer.tools"], "after closing Layers")
  await page.keyboard.press("Control+k")
  await input.fill("layers")
  const options = page.getByRole("option")
  if ((await options.count()) !== 1) throw new Error(`"layers" should match one command, got ${await options.count()}`)
  await page.keyboard.press("Enter")
  await dialog.waitFor({ state: "hidden" })
  await expectPanels(page, QUERY, "Layers reopened from the palette")

  // Arrow keys move the selection; Enter switches the preset.
  await page.keyboard.press("Control+k")
  await input.fill("preset")
  await page.keyboard.press("ArrowDown")
  const selected = await page.locator('[role="option"][aria-selected="true"]').getAttribute("data-command")
  if (selected !== "preset:explore") throw new Error(`expected preset:explore selected, got ${selected}`)
  await page.keyboard.press("Enter")
  await expectPanels(page, EXPLORE, "Explore from the palette")

  // Escape closes without running anything; no match shows an empty state.
  await page.keyboard.press("Control+k")
  await input.fill("zzzz")
  await page.getByText("No matching commands").waitFor()
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })

  // The header button opens it too, and Reset layout is a command.
  await page.getByTestId("open-palette").click()
  await input.fill("reset")
  await page.keyboard.press("Enter")
  await expectPanels(page, QUERY, "Reset from the palette")
  console.log("e2e ok: Ctrl+K palette filters, reopens closed panels, switches presets, resets, and is keyboard operable")
})
