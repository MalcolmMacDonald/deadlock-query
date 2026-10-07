/** The two kinds of map geometry the viewer draws under the overlays. */
export type SurfaceKind = "render" | "collision"

export interface SurfaceState {
  readonly kind: SurfaceKind
  readonly label: string
  /** The loaded map carries this mesh (a disabled row in the panel otherwise). */
  readonly available: boolean
  readonly visible: boolean
}

export const SURFACE_LABELS: Readonly<Record<SurfaceKind, string>> = { render: "Render mesh", collision: "Collision mesh" }

/**
 * Which map meshes are shown. The render mesh is the default view; the collision mesh is opt-in. When a bundle has
 * no render tiles the collision mesh is shown instead until the user chooses otherwise, so the map is never empty.
 * Kept outside the panel (like `LayerStore`) so it survives remounts and map changes.
 */
export class SurfaceStore {
  private avail: Record<SurfaceKind, boolean> = { render: false, collision: false }
  private chosen: Partial<Record<SurfaceKind, boolean>> = {}
  private readonly listeners = new Set<() => void>()

  /** Records what the loaded map has; call again when the map changes. */
  setAvailable(a: Readonly<Record<SurfaceKind, boolean>>) {
    if (a.render === this.avail.render && a.collision === this.avail.collision) return
    this.avail = { ...a }
    this.emit()
  }

  isAvailable(kind: SurfaceKind): boolean { return this.avail[kind] }

  /** The user's choice, else the default: render on, collision only as the fallback for a map without render tiles. */
  isVisible(kind: SurfaceKind): boolean {
    const c = this.chosen[kind]
    if (c !== undefined) return c
    return kind === "render" ? true : !this.avail.render
  }

  /** Shows or hides one mesh; the choice sticks across map loads. */
  set(kind: SurfaceKind, visible: boolean) {
    if (this.chosen[kind] === visible) return
    this.chosen = { ...this.chosen, [kind]: visible }
    this.emit()
  }

  list(): ReadonlyArray<SurfaceState> {
    return (["render", "collision"] as const).map((kind) => ({
      kind, label: SURFACE_LABELS[kind], available: this.avail[kind], visible: this.isVisible(kind)
    }))
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit() { for (const fn of [...this.listeners]) fn() }
}
