import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Submission, type MetadataRecord } from "@deadlock-query/contracts"
import { buildSubmission, issueLink, submissionFile, checkDocument } from "../src/index.ts"

const camp = (id: string, x = 0): MetadataRecord => ({ id, kind: "creepCamp", status: "proposed", provenance: {}, position: [x, 0, 0] })
const meta = { gameBuildId: "b1", mapName: "dl_midtown", submitter: { name: " Ada ", github: "@ada" }, now: new Date("2026-10-07T05:00:00Z"), id: "sub-1" }

test("drafts become a schema-valid submission stamped with the submitter", () => {
  const r = buildSubmission([camp("a"), camp("b", 1000)], meta)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.submission.submitter).toEqual({ name: "Ada", github: "ada" })
  expect(r.submission.records[0]!.provenance).toMatchObject({ submissionId: "sub-1", submittedAt: "2026-10-07T05:00:00.000Z" })
  expect(Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Submission)(r.submission)))._tag).toBe("Success")
  // The downloaded file passes the same document check the worker and CLI use.
  expect(checkDocument(submissionFile(r.submission).text, {}, { as: "submission" }).ok).toBe(true)
})

test("rejected drafts, empty input and a missing name are refused with a reason", () => {
  expect(buildSubmission([], meta)).toMatchObject({ ok: false })
  expect(buildSubmission([camp("a")], { ...meta, submitter: { name: "  " } }).report.issues[0]!.code).toBe("submitter-name")
  const dup = buildSubmission([camp("a"), camp("b", 10)], meta)
  expect(dup.ok).toBe(false)
  expect(dup.report.issues.some((i) => i.code === "duplicate-nearby")).toBe(true)
})

test("a draft that was edited to another status is still sent as proposed", () => {
  const r = buildSubmission([{ ...camp("a"), status: "accepted" }], meta)
  expect(r.ok && r.submission.records[0]!.status).toBe("proposed")
})

test("issue link prefills title, label and the JSON, and falls back to 'attach' when too long", () => {
  const r = buildSubmission([camp("a")], { ...meta, note: "Mid lane camp" })
  if (!r.ok) throw new Error("setup")
  const small = issueLink(r.submission)
  const u = new URL(small.url)
  expect(u.searchParams.get("labels")).toBe("metadata-submission")
  expect(u.searchParams.get("title")).toContain("sub-1")
  expect(small.inlined).toBe(true)
  expect(u.searchParams.get("body")).toContain('"creepCamp"')
  const big = issueLink(r.submission, { maxUrl: 500 })
  expect(big.inlined).toBe(false)
  expect(new URL(big.url).searchParams.get("body")).toContain("metadata-submission-sub-1.json")
})

import { postSubmission } from "../src/index.ts"
test("postSubmission maps worker answers to messages and never throws", async () => {
  const ok = await postSubmission("{}", { url: "u", turnstileToken: "t", fetch: (async () => Response.json({ id: "a", url: "https://x/1" }, { status: 201 })) as unknown as typeof fetch })
  expect(ok).toEqual({ ok: true, id: "a", url: "https://x/1" })
  const limited = await postSubmission("{}", { url: "u", turnstileToken: "t", fetch: (async () => Response.json({ error: { code: "rate-limited", message: "x" } }, { status: 429 })) as unknown as typeof fetch })
  expect(limited).toMatchObject({ ok: false, status: 429 })
  expect(!limited.ok && limited.message).toContain("download fallback")
  const down = await postSubmission("{}", { url: "u", turnstileToken: "t", fetch: (async () => { throw new Error("net") }) as unknown as typeof fetch })
  expect(down).toMatchObject({ ok: false, status: 0 })
})
