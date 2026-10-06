import { expect, test } from "bun:test"
import { join } from "node:path"

// The shell bundles the package entry for the browser: it must not pull in node built-ins (e.g. the fs-based library reader).
test("package entry bundles for the browser and exports the panel API", async () => {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/index.ts")], target: "browser", loader: { ".ttf": "file" }, minify: false })
  expect(r.success).toBe(true)
  const text = (await Promise.all(r.outputs.filter((o) => o.path.endsWith(".js")).map((o) => o.text()))).join("\n")
  expect(text).not.toMatch(/node:(fs|path|os)/)
  expect(text).toContain("makeQueryEditorPanel")
}, 60_000)

test("package.json exposes src/index.ts as the only entry", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json()
  expect(pkg.exports).toEqual({ ".": "./src/index.ts" })
})
