import { describe, expect, test } from "bun:test"
import { extractRequests, requestDraft } from "../src/index.ts"

const state = `# x — state

## Blockers / Requests to other modules
- (none)
- contracts: add \`captureImage\` options
- [infra] allow PR reviews on the proxy
- something with no target

## Decisions log
- not a request
`

describe("extractRequests", () => {
  test("reads only the requests section and finds the target module", () => {
    const r = extractRequests(state, "kanban", ["contracts", "infra"])
    expect(r.map((x) => x.target)).toEqual(["contracts", "infra", undefined])
    expect(r).toHaveLength(3)
    expect(r[0]!.from).toBe("kanban")
  })
  test("no section or only (none) gives nothing", () => {
    expect(extractRequests("# s\n## Done\n- x", "a")).toEqual([])
    expect(extractRequests("## Blockers / Requests\n- (none)\n", "a")).toEqual([])
  })
  test("draft labels only a known target and truncates long titles", () => {
    expect(requestDraft({ from: "kanban", text: "contracts: x", target: "contracts" }).labels).toEqual(["module:contracts"])
    expect(requestDraft({ from: "kanban", text: "y" }).labels).toEqual([])
    expect(requestDraft({ from: "k", text: "z".repeat(100) }).title).toHaveLength(80)
  })
})
