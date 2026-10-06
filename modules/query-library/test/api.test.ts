import { expect, test } from "bun:test"
import { currentApi, diffApi, readSnapshot } from "../scripts/api.ts"

test("public API matches test/api.snapshot.json (run `bun run api:update` to accept)", async () => {
  const snap = readSnapshot()
  const cur = await currentApi()
  const { removedOrChanged, added } = diffApi(snap.symbols, cur.symbols)
  const report = [...removedOrChanged.map((s) => `- ${s}`), ...added.map((s) => `+ ${s}`)].join("\n")
  expect(report).toBe("")
  expect(cur.apiVersion).toBe(snap.apiVersion)
})
