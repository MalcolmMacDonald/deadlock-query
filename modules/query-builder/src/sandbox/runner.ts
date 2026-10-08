import { frameHtml } from "./frame.ts"

export type RunOutcome =
  | { readonly ok: true; readonly value: unknown; readonly ms: number; readonly totalRows?: number; readonly provisional?: boolean }
  | { readonly ok: false; readonly reason: "error" | "cancelled" | "timeout"; readonly message: string }

/** Serialized spatial-core data (`Raycaster.serialize()` / `NavMesh.serialize()`) from the bundle's `baked/` files. */
export interface BakedBuffers { readonly bvh?: ArrayBuffer; readonly navmesh?: ArrayBuffer }

export interface RunOptions { readonly timeoutMs?: number }

/** Main-thread handle to the sandboxed iframe→Worker. One run at a time. */
export class SandboxRunner {
  private frame: HTMLIFrameElement
  private nextId = 1
  private readyWaiters: Array<() => void> = []
  private isReady = false
  private active: { runId: number; settle: (o: RunOutcome) => void } | undefined
  /** Called with `progress(f)` reports of the running query (fraction 0..1). Set by the panel; one listener. */
  onProgress: ((fraction: number, label?: string) => void) | undefined

  constructor(private readonly doc: Document, prelude = "") {
    const nonce = crypto.randomUUID().replaceAll("-", "")
    this.frame = doc.createElement("iframe")
    this.frame.setAttribute("sandbox", "allow-scripts")
    this.frame.setAttribute("allow", "") // no powerful features (camera, geolocation, …) even if the sandbox were loosened
    this.frame.setAttribute("referrerpolicy", "no-referrer")
    this.frame.style.display = "none"
    this.frame.srcdoc = frameHtml(nonce, prelude)
    doc.defaultView!.addEventListener("message", this.onMessage)
    doc.body.append(this.frame)
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow) return
    const m = e.data
    if (m.type === "ready") {
      this.isReady = true
      this.readyWaiters.splice(0).forEach((f) => f())
    } else if (this.active && m.runId === this.active.runId) {
      const { settle } = this.active
      if (m.type === "progress") { this.onProgress?.(m.fraction, m.label); return }
      if (m.type === "result") settle({ ok: true, value: m.value, ms: m.ms, ...(m.totalRows === undefined ? {} : { totalRows: m.totalRows }), ...(m.provisional ? { provisional: true } : {}) })
      else if (m.type === "error") settle({ ok: false, reason: m.cancelled ?? "error", message: m.message })
    }
  }

  ready(): Promise<void> {
    return this.isReady ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r))
  }

  /** Terminates the worker and resolves once a fresh one is ready. */
  async cancel(reason: "cancelled" | "timeout" = "cancelled"): Promise<void> {
    const a = this.active
    this.isReady = false
    const back = this.ready()
    this.post({ type: "cancel", runId: a?.runId ?? 0 })
    a?.settle({ ok: false, reason, message: reason })
    await back
  }

  /** Sends the map bundle to the worker; it is replayed after every respawn. Resolves once the worker is ready. */
  async load(bundle: unknown, baked?: BakedBuffers): Promise<void> {
    await this.ready()
    this.isReady = false
    const back = this.ready()
    // The buffers move to the frame (no copy); the frame keeps them and clones them into each respawned worker.
    const transfer = [baked?.bvh, baked?.navmesh].filter((b): b is ArrayBuffer => b !== undefined)
    this.frame.contentWindow!.postMessage({ type: "load", bundle, ...(baked ? { baked } : {}) }, "*", transfer)
    await back
  }

  async run(js: string, opts: RunOptions = {}): Promise<RunOutcome> {
    await this.ready()
    const runId = this.nextId++
    return new Promise<RunOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (o: RunOutcome) => {
        clearTimeout(timer)
        if (this.active?.runId === runId) this.active = undefined
        resolve(o)
      }
      this.active = { runId, settle }
      if (opts.timeoutMs) timer = setTimeout(() => void this.cancel("timeout"), opts.timeoutMs)
      this.post({ type: "run", runId, js })
    })
  }

  dispose() {
    this.doc.defaultView!.removeEventListener("message", this.onMessage)
    this.frame.remove()
  }

  private post(m: unknown) { this.frame.contentWindow!.postMessage(m, "*") }
}
