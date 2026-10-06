import type { OverlayFeature, Vec3 } from "@deadlock-query/contracts"
import type { NewAnnotation } from "./annotations.ts"

export type ToolId = "select" | "point" | "label" | "polyline" | "polygon" | "measure"

export const TOOL_IDS: ReadonlyArray<ToolId> = ["select", "point", "label", "polyline", "polygon", "measure"]

export const DRAFT_COLOR = "#4fc3ff"

/** Clicks closer together than this in time and space are one click (the second half of a double-click). */
const DEBOUNCE_MS = 500
const SAME_POINT = 1e-6

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * State machine for the annotation tools. The host feeds it world-space clicks / hover points and keys; finished
 * shapes go to `commit`. Pure of DOM and Three so it unit-tests directly.
 */
export class ToolMachine {
  private current: ToolId = "select"
  private points: Vec3[] = []
  private hover: Vec3 | undefined
  private last: { readonly p: Vec3; readonly t: number } | undefined
  private readonly listeners = new Set<() => void>()

  /** Supplies text for the label tool; return null/empty to cancel. */
  askText: () => string | null = () => null

  constructor(private readonly commit: (a: NewAnnotation) => void) {}

  get tool(): ToolId { return this.current }
  /** Points placed so far for the shape in progress. */
  get pending(): number { return this.points.length }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  setTool(tool: ToolId) {
    if (tool === this.current) return
    this.points = []
    this.hover = undefined
    this.current = tool
    this.emit()
  }

  click(p: Vec3, now = Date.now()) {
    if (this.last && now - this.last.t < DEBOUNCE_MS && dist(this.last.p, p) < SAME_POINT) return
    this.last = { p, t: now }
    switch (this.current) {
      case "select": return
      case "point": this.commit({ kind: "point", points: [p] }); return
      case "label": {
        const text = this.askText()?.trim()
        if (text) this.commit({ kind: "label", points: [p], text })
        return
      }
      case "measure":
        this.points.push(p)
        if (this.points.length === 2) { this.commit({ kind: "measure", points: this.points }); this.points = [] }
        break
      case "polyline":
      case "polygon":
        this.points.push(p)
        break
    }
    this.emit()
  }

  move(p: Vec3 | undefined) {
    if (this.points.length === 0) return
    this.hover = p
    this.emit()
  }

  /** Completes the polyline/polygon in progress; too-short shapes are dropped. */
  finish() {
    const min = this.current === "polygon" ? 3 : this.current === "polyline" ? 2 : Infinity
    if (this.points.length >= min) this.commit({ kind: this.current as "polyline" | "polygon", points: this.points })
    this.cancel()
  }

  /** Abandons the shape in progress. */
  cancel() {
    if (this.points.length === 0 && !this.hover) return
    this.points = []
    this.hover = undefined
    this.emit()
  }

  /** Rubber-band preview of the shape in progress, in overlay features. */
  draft(): ReadonlyArray<OverlayFeature> {
    if (this.points.length === 0) return []
    const out: OverlayFeature[] = this.points.map((at) => ({ type: "point", at }))
    const path = this.hover ? [...this.points, this.hover] : this.points
    if (this.current === "polygon" && path.length >= 3) out.push({ type: "polygon", ring: path })
    else if (path.length >= 2) out.push({ type: "polyline", points: path })
    return out
  }

  private emit() { for (const fn of [...this.listeners]) fn() }
}
