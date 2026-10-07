import * as THREE from "three"
import {
  CAMERA_KEYS, eyeOf, fly, keyboardStep, pan, pinchDelta, rotate, switchMode, zoom,
  type CameraMode, type CameraPose, type TouchPair
} from "./camera.ts"
import { decodeCamera, encodeCamera } from "./hashState.ts"

export const FOV_DEG = 50

export interface ViewerControlsOptions {
  readonly element: HTMLElement
  readonly camera: THREE.PerspectiveCamera
  readonly initial: { readonly mode: CameraMode; readonly pose: CameraPose }
  readonly onChange: () => void
  /** Return true to keep a pointer-down for the host (a vertex drag) instead of starting a camera gesture. */
  readonly intercept?: (e: PointerEvent) => boolean
  /** Window used for hash read/write; injectable for tests. */
  readonly location?: Pick<Location, "hash">
}

/** Map / Orbit / Fly input handling over a shared world-space pose. Renders on demand via `onChange`. */
export class ViewerControls {
  mode: CameraMode
  pose: CameraPose
  private readonly keys = new Set<string>()
  private readonly disposers: Array<() => void> = []
  private raf = 0
  private hashTimer: ReturnType<typeof setTimeout> | undefined
  private flySpeed = 1500

  constructor(private readonly o: ViewerControlsOptions) {
    const fromHash = decodeCamera((o.location ?? window.location).hash)
    this.mode = fromHash?.mode ?? o.initial.mode
    this.pose = fromHash?.pose ?? o.initial.pose
    this.bind()
    this.apply()
  }

  setMode(mode: CameraMode) {
    this.mode = mode
    this.pose = switchMode(this.pose, mode)
    this.apply()
  }

  setPose(pose: CameraPose) {
    this.pose = pose
    this.apply()
  }

  /** Writes the pose to the Three camera (world Z-up -> Three Y-up) and schedules hash + render. */
  apply() {
    const e = eyeOf(this.pose), t = this.pose.target
    this.o.camera.position.set(e[0], e[2], -e[1])
    this.o.camera.up.set(0, 1, 0)
    this.o.camera.lookAt(t[0], t[2], -t[1])
    this.o.camera.updateMatrixWorld()
    this.o.onChange()
    clearTimeout(this.hashTimer)
    this.hashTimer = setTimeout(() => {
      const loc = this.o.location ?? window.location
      const next = encodeCamera({ mode: this.mode, pose: this.pose })
      try { history.replaceState(null, "", `#${next}`) } catch { loc.hash = next }
    }, 150)
  }

  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    el.addEventListener(type, fn, opts)
    this.disposers.push(() => el.removeEventListener(type, fn, opts))
  }

  private bind() {
    const el = this.o.element
    let last: { x: number; y: number; button: number } | undefined
    el.tabIndex = 0
    el.style.touchAction = "none"
    this.on(el, "contextmenu", (e: Event) => e.preventDefault())
    // Touch: two fingers pinch to zoom and drag to pan (any mode); one finger keeps the mode's usual drag.
    const touches = new Map<number, { x: number; y: number }>()
    const pair = (): TouchPair | undefined => {
      const v = [...touches.values()]
      return v.length === 2 ? [v[0]!, v[1]!] : undefined
    }
    this.on(el, "pointerdown", (e: PointerEvent) => {
      el.focus()
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (touches.size === 2) { last = undefined; el.setPointerCapture?.(e.pointerId); return }
      }
      if (this.o.intercept?.(e)) return
      last = { x: e.clientX, y: e.clientY, button: e.button }
      el.setPointerCapture?.(e.pointerId)
      el.focus()
    })
    const release = (e: PointerEvent) => { touches.delete(e.pointerId); last = undefined }
    this.on(el, "pointerup", release)
    this.on(el, "pointercancel", release)
    this.on(el, "pointermove", (e: PointerEvent) => {
      if (touches.has(e.pointerId)) {
        const before = pair()
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const after = pair()
        if (before && after) {
          const d = pinchDelta(before, after)
          this.pose = zoom(pan(this.pose, d.dx, d.dy, el.clientHeight, FOV_DEG), 1 / d.scale)
          this.apply()
          return
        }
      }
      if (!last) return
      const dx = e.clientX - last.x, dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY, button: last.button }
      const h = el.clientHeight
      if (this.mode === "map" || last.button === 2 || e.shiftKey) {
        this.pose = pan(this.pose, dx, dy, h, FOV_DEG)
      } else if (this.mode === "orbit") {
        this.pose = rotate(this.pose, -dx * 0.005, -dy * 0.005, "target")
      } else {
        this.pose = rotate(this.pose, -dx * 0.004, -dy * 0.004, "eye")
      }
      this.apply()
    })
    this.on(el, "wheel", (e: WheelEvent) => {
      e.preventDefault()
      if (this.mode === "fly") this.flySpeed = Math.min(20000, Math.max(100, this.flySpeed * Math.exp(-e.deltaY * 0.001)))
      else this.pose = zoom(this.pose, Math.exp(e.deltaY * 0.001))
      this.apply()
    }, { passive: false })
    this.on(el, "keydown", (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === "1") this.setMode("map")
      else if (k === "2") this.setMode("orbit")
      else if (k === "3") this.setMode("fly")
      // Shortcuts (Ctrl+A select all, Ctrl+S, ...) must not also fly the camera.
      else if (CAMERA_KEYS.includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        this.pose = keyboardStep(this.pose, this.mode, e.key, el.clientHeight, e.shiftKey, FOV_DEG)
        this.apply()
      }
      else if (this.mode === "fly" && "wasdqe".includes(k) && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.keys.add(k)
        this.startLoop()
      }
    })
    this.on(el, "keyup", (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()))
    this.on(el, "blur", () => this.keys.clear())
    this.on(window, "hashchange", () => {
      const h = decodeCamera((this.o.location ?? window.location).hash)
      if (h && (h.mode !== this.mode || h.pose !== this.pose)) { this.mode = h.mode; this.pose = h.pose; this.apply() }
    })
  }

  private startLoop() {
    if (this.raf) return
    let prev = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000)
      prev = now
      if (this.keys.size === 0 || this.mode !== "fly") { this.raf = 0; return }
      const k = this.keys
      this.pose = fly(
        this.pose,
        (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0),
        (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0),
        (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0),
        this.flySpeed * dt
      )
      this.apply()
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  dispose() {
    clearTimeout(this.hashTimer)
    if (this.raf) cancelAnimationFrame(this.raf)
    for (const d of this.disposers) d()
  }
}
