// M3: share-layout link: copy, open in a fresh browser profile, bad links fall back. Run: bun e2e/share.ts
import { EXPLORE, expectPanels, QUERY, withShell } from "./util.ts"

await withShell(4177, async ({ open }) => {
  const a = await open()
  await a.getByTestId("preset-explore").click()
  await expectPanels(a, EXPLORE, "Explore before sharing")
  await a.getByTestId("share-layout").click()
  await a.getByTestId("notice").getByText("Layout link copied").waitFor()
  const link = await a.evaluate(() => navigator.clipboard.readText())
  if (!link.includes("#layout=")) throw new Error(`clipboard has no layout link: ${link}`)

  // A fresh profile (default layout otherwise) lands on the shared layout, then drops the hash.
  const b = await open(new URL(link).hash)
  await expectPanels(b, EXPLORE, "shared layout in a new profile")
  if (new URL(b.url()).hash !== "") throw new Error(`hash should be cleared after applying, got ${new URL(b.url()).hash}`)
  await b.reload()
  await expectPanels(b, EXPLORE, "shared layout persists after reload")

  // Pasting a link into an open tab applies it too.
  await b.getByTestId("preset-query").click()
  await expectPanels(b, QUERY, "tab back on Query")
  await b.evaluate((hash) => { location.hash = hash }, new URL(link).hash)
  await expectPanels(b, EXPLORE, "link pasted into an open tab")

  // Corrupt links, and links naming panels this build does not have, fall back to the default layout.
  const bad = await open("#layout=not-a-layout")
  await expectPanels(bad, QUERY, "corrupt link")
  const unknown = Buffer.from(JSON.stringify({ version: 2, layout: { grid: {}, panels: { nope: {} } } })).toString("base64url")
  const stale = await open(`#layout=${unknown}`)
  await expectPanels(stale, QUERY, "link naming an unknown panel")
  console.log("e2e ok: share link round-trips to a fresh profile, applies from the hash, and bad links fall back to the default")
})
