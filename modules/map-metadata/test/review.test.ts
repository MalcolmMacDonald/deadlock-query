import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Submission, type MetadataFile, type MetadataKind } from "@deadlock-query/contracts"
import { Schema, Effect } from "effect"
import { applyDecisions, bulkDecisions, commitDecisions, loadForReview, proxyApi, rejectSubmission, requestChanges, type QueueItem, type ReviewApi } from "../src/index.ts"

const sub: Submission = Effect.runSync(Schema.decodeUnknownEffect(Submission)(JSON.parse(readFileSync(new URL("../fixtures/submissions/valid.json", import.meta.url), "utf8"))))
const item: QueueItem = { number: 9, title: "t", branch: `metadata-submission/${sub.id}`, submissionId: sub.id, url: "u", author: "bot", updatedAt: "" }
const now = new Date("2026-10-07T06:00:00Z")

const fakeApi = (existing: Partial<Record<MetadataKind, MetadataFile>> = {}) => {
  const log: string[] = []
  const commits: { path: string; text: string; sha: string | undefined }[] = []
  const api: ReviewApi = {
    queue: async () => [item],
    submission: async () => sub,
    dataFile: async (_i, _b, k) => existing[k] ? { file: existing[k]!, sha: `sha-${k}` } : undefined,
    commitFile: async (_i, path, text, _m, sha) => { commits.push({ path, text, sha }) },
    merge: async () => { log.push("merge") },
    close: async (_i, c) => { log.push(`close:${c}`) },
    comment: async (_i, c) => { log.push(`comment:${c}`) }
  }
  return { api, log, commits }
}

test("applyDecisions stamps reviewer, date and comment and writes one file per kind under the build", () => {
  const out = applyDecisions(sub, sub.records.map((r, i) => ({ recordId: r.id, decision: i === 0 ? "rejected" as const : "accepted" as const, comment: i === 0 ? "wrong spot" : undefined })), "Malcolm", now)
  expect(out.accepted).toBe(sub.records.length - 1)
  expect(out.rejected).toBe(1)
  for (const f of out.files) expect(f.path).toBe(`data/metadata/${sub.gameBuildId}/${f.kind}.json`)
  const rejected = out.files.flatMap((f) => (JSON.parse(f.text) as MetadataFile).records).find((r) => r.status === "rejected")!
  expect(rejected.provenance).toMatchObject({ reviewer: "Malcolm", reviewedAt: now.toISOString(), comment: "wrong spot" })
})

test("merging keeps existing records, replaces the same id, and sorts by id", () => {
  const first = sub.records[0]!
  const existing: MetadataFile = { schemaVersion: "1.0.0", gameBuildId: sub.gameBuildId, mapName: sub.mapName, records: [{ ...first, id: "zzz", status: "accepted" }, { ...first, id: first.id, status: "rejected" }] }
  const out = applyDecisions({ ...sub, records: [first] }, [{ recordId: first.id, decision: "accepted" }], "M", now, { [first.kind]: existing })
  const ids = (JSON.parse(out.files[0]!.text) as MetadataFile).records.map((r) => [r.id, r.status])
  expect(ids).toEqual([[first.id, "accepted"], ["zzz", "accepted"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)))
  // Deterministic text: identical input gives identical output.
  expect(applyDecisions({ ...sub, records: [first] }, [{ recordId: first.id, decision: "accepted" }], "M", now, { [first.kind]: existing }).files[0]!.text).toBe(out.files[0]!.text)
})

test("commitDecisions commits files to the branch with the existing sha, then merges", async () => {
  const { api, log, commits } = fakeApi()
  const l = await loadForReview(api, item)
  const out = await commitDecisions(api, l, bulkDecisions(l, "acceptValid"), "Malcolm", now)
  expect(out.accepted).toBe(sub.records.length)
  expect(commits.length).toBeGreaterThan(0)
  expect(commits.every((c) => c.path.startsWith("data/metadata/") && c.sha === undefined)).toBe(true)
  expect(log).toEqual(["merge"])
  const withFile = fakeApi({ [sub.records[0]!.kind]: { schemaVersion: "1.0.0", gameBuildId: sub.gameBuildId, mapName: sub.mapName, records: [] } })
  await commitDecisions(withFile.api, l, bulkDecisions(l, "acceptValid"), "M", now)
  expect(withFile.commits.find((c) => c.path.endsWith(`${sub.records[0]!.kind}.json`))!.sha).toBe(`sha-${sub.records[0]!.kind}`)
})

test("rejecting everything closes the PR instead of merging; undecided records are refused", async () => {
  const { api, log } = fakeApi()
  const l = await loadForReview(api, item)
  await commitDecisions(api, l, bulkDecisions(l, "rejectAll", "not useful"), "Malcolm", now)
  expect(log).toHaveLength(1)
  expect(log[0]).toStartWith("close:")
  await expect(commitDecisions(api, l, [], "M", now)).rejects.toThrow("Nothing decided")
  if (sub.records.length > 1) await expect(commitDecisions(api, l, [{ recordId: sub.records[0]!.id, decision: "accepted" }], "M", now)).rejects.toThrow("undecided")
})

test("request changes comments and reject closes with the reason", async () => {
  const { api, log } = fakeApi()
  const l = await loadForReview(api, item)
  await requestChanges(api, l, "Malcolm", "move the camp")
  await rejectSubmission(api, l, "Malcolm", "duplicate")
  expect(log).toEqual(["comment:Changes requested by Malcolm:\n\nmove the camp", "close:Rejected by Malcolm: duplicate"])
})

test("bulk accept-valid rejects records that have validation errors", async () => {
  const bad = { ...sub, records: [sub.records[0]!, { ...sub.records[0]!, id: sub.records[0]!.id }] } as Submission   // duplicate id: an error on that record
  const api = fakeApi().api
  const l = await loadForReview({ ...api, submission: async () => bad }, item)
  const d = bulkDecisions(l, "acceptValid")
  expect(d.every((x) => x.decision === "rejected")).toBe(true)
})

// The proxy adapter: paths, CSRF header, base64 and the branch filter.
test("proxyApi talks to /api/github with the CSRF header and filters to submission branches", async () => {
  const calls: { method: string; url: string; csrf: string | null; body?: any }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, csrf: new Headers(init.headers).get("x-dlq-csrf"), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.includes("/pulls?")) return Response.json([
      { number: 1, title: "a", html_url: "u1", user: { login: "bot" }, head: { ref: "metadata-submission/s1", repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } },
      { number: 2, title: "b", html_url: "u2", user: { login: "x" }, head: { ref: "feature", repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } },
      { number: 3, title: "c", html_url: "u3", user: { login: "x" }, head: { ref: "metadata-submission/s3", repo: { full_name: "fork/r" } }, base: { repo: { full_name: "o/r" } } }
    ])
    if (init.method === "GET" && url.includes("/contents/data/metadata/")) return Response.json({}, { status: 404 })
    return Response.json({ content: btoa(JSON.stringify(sub)), sha: "s" })
  }) as unknown as typeof fetch
  const api = proxyApi(f)
  const q = await api.queue()
  expect(q.map((x) => x.number)).toEqual([1])
  expect(q[0]!.submissionId).toBe("s1")
  expect((await api.submission({ ...item, submissionId: "s1", branch: "metadata-submission/s1" })).id).toBe(sub.id)
  expect(await api.dataFile(item, "b", "creepCamp")).toBeUndefined()
  await api.commitFile(item, "data/metadata/b/creepCamp.json", "x", "m", undefined)
  await api.merge(item)
  expect(calls.every((c) => c.csrf === "1")).toBe(true)
  expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/merge"))).toBeDefined()
  expect(calls.find((c) => c.url.includes("/contents/data/submissions/s1.json?ref=metadata-submission%2Fs1"))).toBeDefined()
})
