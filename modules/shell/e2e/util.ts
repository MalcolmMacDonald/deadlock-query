// Shared harness for the M3 e2e scripts: `vite preview` of the built shell plus a Chromium. Needs a prior `vite build`.
import { chromium, type Browser, type Page } from "playwright-core"
import { spawn } from "node:child_process"

export interface Harness {
  readonly browser: Browser
  readonly url: string
  /** A fresh page (own localStorage) on the app, with the dock ready. */
  readonly open: (hash?: string, opts?: { readonly beforeLoad?: (page: Page) => Promise<void>; readonly waitForDock?: boolean }) => Promise<Page>
}

/** `outDir`: serve that build instead of `dist` (e.g. a `VITE_TARGET=dev` build). */
export const withShell = async (port: number, run: (h: Harness) => Promise<void>, outDir?: string): Promise<void> => {
  const server = spawn("bunx", ["vite", "preview", "--port", String(port), "--strictPort", ...(outDir ? ["--outDir", outDir] : [])], { stdio: "ignore" })
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] })
  const url = `http://localhost:${port}/`
  try {
    await run({
      browser,
      url,
      open: async (hash = "", opts = {}) => {
        const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
        const page = await ctx.newPage()
        await opts.beforeLoad?.(page)
        for (let i = 0; i < 50; i++) {
          try { await page.goto(url + hash); break } catch { await Bun.sleep(200) }
        }
        if (opts.waitForDock !== false) await page.waitForFunction(() => ((globalThis as any).__dockview?.panels.length ?? 0) > 0, null, { timeout: 20000 })
        return page
      },
    })
  } finally {
    await browser.close()
    server.kill()
  }
}

/** Ids of the panels currently in the dock, sorted (empty while the dock is still starting, e.g. just after a reload). */
export const panelIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (((globalThis as any).__dockview?.panels ?? []) as Array<{ id: string }>).map((p) => p.id).sort())

export const expectPanels = async (page: Page, expected: string[], what: string): Promise<void> => {
  const want = [...expected].sort()
  for (let i = 0; i < 30; i++) {
    if (JSON.stringify(await panelIds(page)) === JSON.stringify(want)) return
    await Bun.sleep(100)
  }
  throw new Error(`${what}: expected panels ${want.join(",")} but found ${(await panelIds(page)).join(",")}`)
}

export const QUERY = ["query.editor", "viewer.layers", "viewer.main", "viewer.tools"]
export const EXPLORE = ["viewer.layers", "viewer.main", "viewer.tools"]
