import type { ExternalTool, OverlayFeature, ToolContext, Vec3 } from "@deadlock-query/contracts"
import type { Annotation, NewAnnotation } from "./annotations.ts"

export type BuiltinToolId = "select" | "point" | "label" | "polyline" | "polygon" | "measure"
/** A built-in tool, or the id of a tool registered through `ToolMachine.register`. */
export type ToolId = BuiltinToolId | (string & {})

export const TOOL_IDS: ReadonlyArray<BuiltinToolId> = ["select", "point", "label", "polyline", "polygon", "measure"]

export type { ExternalTool, ToolContext }

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

  private readonly external = new Map<string, ExternalTool>()
  private externalDraft: ReadonlyArray<OverlayFeature> = []
  private externalStatus: string | undefined

  constructor(private readonly commit: (a: NewAnnotation) => Annotation | void) {}

  get tool(): ToolId { return this.current }

  /** Tools registered by other modules, in registration order. */
  get registered(): ReadonlyArray<ExternalTool> { return [...this.external.values()] }
  /** Status line of the active external tool, if it set one. */
  get status(): string | undefined { return this.externalStatus }
  private active(): ExternalTool | undefined { return this.external.get(this.current) }

  /**
   * Registers a tool (this is the viewer's `registerTool`); returns the unregister function. A tool that is active
   * when it is unregistered is deactivated and the Select tool takes over.
   */
  register(tool: ExternalTool): () => void {
    if ((TOOL_IDS as ReadonlyArray<string>).includes(tool.id)) throw new Error(`tool id "${tool.id}" is a built-in tool`)
    if (this.external.has(tool.id)) throw new Error(`tool "${tool.id}" is already registered`)
    this.external.set(tool.id, tool)
    this.emit()
    return () => {
      if (this.external.get(tool.id) !== tool) return
      if (this.current === tool.id) this.setTool("select")
      this.external.delete(tool.id)
      this.emit()
    }
  }

  private contextFor(tool: ExternalTool): ToolContext {
    const live = () => this.external.get(this.current) === tool
    return {
      commit: (a) => {
        const made = this.commit(a)
        if (!made) throw new Error("the viewer did not store the annotation")
        return made
      },
      setDraft: (f) => { if (live()) { this.externalDraft = f; this.emit() } },
      setStatus: (t) => { if (live()) { this.externalStatus = t; this.emit() } },
      done: () => { if (live()) this.setTool("select") }
    }
  }
  /** Points placed so far for the shape in progress. */
  get pending(): number { return this.points.length }
  /** The placed points themselves, so the next click can snap to them (closing a polygon on its first vertex). */
  get placed(): ReadonlyArray<Vec3> { return this.points }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  setTool(tool: ToolId) {
    if (tool === this.current) return
    if (tool !== "select" && !(TOOL_IDS as ReadonlyArray<string>).includes(tool) && !this.external.has(tool)) return
    const leaving = this.active()
    this.points = []
    this.hover = undefined
    this.externalDraft = []
    this.externalStatus = undefined
    this.current = tool
    leaving?.deactivate?.()
    this.active()?.activate?.(this.contextFor(this.active()!))
    this.emit()
  }

  click(p: Vec3, now = Date.now()) {
    if (this.last && now - this.last.t < DEBOUNCE_MS && dist(this.last.p, p) < SAME_POINT) return
    this.last = { p, t: now }
    const ext = this.active()
    if (ext) { ext.click?.(p); return }
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
    const ext = this.active()
    if (ext) { if (p) ext.move?.(p); return }
    if (this.points.length === 0) return
    this.hover = p
    this.emit()
  }

  /** Completes the polyline/polygon in progress; too-short shapes are dropped. */
  finish() {
    const ext = this.active()
    if (ext) { ext.finish?.(); return }
    const min = this.current === "polygon" ? 3 : this.current === "polyline" ? 2 : Infinity
    if (this.points.length >= min) this.commit({ kind: this.current as "polyline" | "polygon", points: this.points })
    this.cancel()
  }

  /** Abandons the shape in progress. */
  cancel() {
    const ext = this.active()
    if (ext) { ext.cancel?.(); return }
    if (this.points.length === 0 && !this.hover) return
    this.points = []
    this.hover = undefined
    this.emit()
  }

  /** Rubber-band preview of the shape in progress, in overlay features. */
  draft(): ReadonlyArray<OverlayFeature> {
    if (this.active()) return this.externalDraft
    if (this.points.length === 0) return []
    const out: OverlayFeature[] = this.points.map((at) => ({ type: "point", at }))
    const path = this.hover ? [...this.points, this.hover] : this.points
    if (this.current === "polygon" && path.length >= 3) out.push({ type: "polygon", ring: path })
    else if (path.length >= 2) out.push({ type: "polyline", points: path })
    return out
  }

  private emit() { for (const fn of [...this.listeners]) fn() }
}
