import { Effect } from "effect"
import type { MetadataRecord, OverlayFeature, ViewerService } from "@deadlock-query/contracts"
import type { ValidationContext } from "../context.ts"
import { KIND_IDS, kindDefinition } from "../kinds.ts"
import type { RecordDecision } from "./decide.ts"
import type { QueueItem, ReviewApi } from "./github.ts"
import { bulkDecisions, commitDecisions, loadForReview, rejectSubmission, requestChanges, type Loaded } from "./review.ts"

type ViewerShape = (typeof ViewerService)["Service"]

export interface ReviewState {
  readonly queue: ReadonlyArray<QueueItem>
  readonly busy: boolean
  /** Last failure, in words for the reviewer. */
  readonly error: string | undefined
  /** Last success. */
  readonly notice: string | undefined
  readonly open: Loaded | undefined
  readonly decisions: ReadonlyMap<string, RecordDecision>
}

export interface ReviewController {
  readonly state: () => ReviewState
  readonly subscribe: (fn: (s: ReviewState) => void) => () => void
  readonly refresh: () => Promise<void>
  readonly open: (item: QueueItem) => Promise<void>
  readonly close: () => void
  readonly decide: (recordId: string, decision: RecordDecision["decision"] | undefined, comment?: string) => void
  readonly bulk: (mode: "acceptValid" | "rejectAll", comment?: string) => void
  readonly commit: () => Promise<void>
  readonly requestChanges: (comment: string) => Promise<void>
  readonly reject: (reason: string) => Promise<void>
  readonly focus: (recordId: string) => void
  readonly dispose: () => void
}

const LAYER = (k: string) => `metadata.review.${k}`
const featureOf = (r: MetadataRecord): OverlayFeature => {
  const label = r.name ?? kindDefinition(r.kind).label
  const properties = { id: r.id, kind: r.kind, status: r.status }
  switch (r.kind) {
    case "walkableRegion": return { type: "polygon", ring: r.ring, label, properties }
    case "navLink": return { type: "segment", points: [r.from, r.to], label, properties }
    case "custom": return r.geometry.type === "point" ? { type: "point", at: r.geometry.at, label, properties }
      : r.geometry.type === "polyline" ? { type: "polyline", points: r.geometry.points, label, properties } : { type: "polygon", ring: r.geometry.ring, label, properties }
    default: return { type: "point", at: r.position, label, properties }
  }
}

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Review state machine: the queue of submission PRs, one open submission with the reviewer's per-record decisions, and the
 * proposed geometry drawn on the map in a diff colour. All GitHub effects go through `ReviewApi`; every failure ends up in
 * `state().error` instead of being thrown.
 */
export const createReviewController = (o: {
  readonly api: ReviewApi; readonly viewer: ViewerShape; readonly reviewer: () => string
  readonly context?: () => ValidationContext
}): ReviewController => {
  let s: ReviewState = { queue: [], busy: false, error: undefined, notice: undefined, open: undefined, decisions: new Map() }
  const listeners = new Set<(s: ReviewState) => void>()
  const run = (e: Effect.Effect<unknown>) => void Effect.runFork(e)
  const set = (patch: Partial<ReviewState>) => { s = { ...s, ...patch }; for (const fn of listeners) fn(s) }

  const draw = () => {
    for (const k of KIND_IDS) {
      const of = s.open?.submission.records.filter((r) => r.kind === k) ?? []
      if (of.length === 0) run(o.viewer.removeOverlay(LAYER(k)))
      else run(o.viewer.setOverlay(LAYER(k), of.map(featureOf), { color: "#ffd34d", size: 12 }))
    }
  }
  const guarded = async (f: () => Promise<string | void>) => {
    if (s.busy) return
    set({ busy: true, error: undefined, notice: undefined })
    try { const n = await f(); set({ busy: false, ...(n ? { notice: n } : {}) }) } catch (e) { set({ busy: false, error: words(e) }) }
  }
  const needReviewer = () => { const r = o.reviewer().trim(); if (!r) throw new Error("Enter your name as the reviewer first"); return r }
  const done = async (message: string) => { set({ open: undefined, decisions: new Map() }); draw(); set({ queue: await o.api.queue() }); return message }

  return {
    state: () => s,
    subscribe: (fn) => { listeners.add(fn); return () => void listeners.delete(fn) },
    refresh: () => guarded(async () => { set({ queue: await o.api.queue() }) }),
    open: (item) => guarded(async () => {
      const l = await loadForReview(o.api, item, o.context?.() ?? {})
      set({ open: l, decisions: new Map() }); draw()
    }),
    close: () => { set({ open: undefined, decisions: new Map(), error: undefined }); draw() },
    decide: (id, decision, comment) => {
      const m = new Map(s.decisions)
      if (decision === undefined) m.delete(id); else m.set(id, { recordId: id, decision, ...(comment ? { comment } : {}) })
      set({ decisions: m })
    },
    bulk: (mode, comment) => { if (s.open) set({ decisions: new Map(bulkDecisions(s.open, mode, comment).map((d) => [d.recordId, d])) }) },
    commit: () => guarded(async () => {
      if (!s.open) throw new Error("Open a submission first")
      const out = await commitDecisions(o.api, s.open, [...s.decisions.values()], needReviewer())
      return done(out.accepted > 0 ? `Merged: ${out.accepted} accepted, ${out.rejected} rejected.` : `Closed: ${out.rejected} rejected.`)
    }),
    requestChanges: (comment) => guarded(async () => {
      if (!s.open) throw new Error("Open a submission first")
      if (!comment.trim()) throw new Error("Say what should change")
      await requestChanges(o.api, s.open, needReviewer(), comment.trim())
      return "Comment posted; the PR stays open."
    }),
    reject: (reason) => guarded(async () => {
      if (!s.open) throw new Error("Open a submission first")
      if (!reason.trim()) throw new Error("Give a reason for rejecting")
      await rejectSubmission(o.api, s.open, needReviewer(), reason.trim())
      return done("Rejected and closed.")
    }),
    focus: (id) => {
      const r = s.open?.submission.records.find((x) => x.id === id)
      if (!r) return
      const f = featureOf(r)
      const at = f.type === "point" ? f.at : f.type === "polygon" ? f.ring[0]! : f.points[0]!
      run(o.viewer.flyTo(at, 600))
    },
    dispose: () => { listeners.clear(); for (const k of KIND_IDS) run(o.viewer.removeOverlay(LAYER(k))) }
  }
}
