/** What the surface needs to draw one overlay layer. `color` is an override of the layer's own style colour. */
export interface LayerAppearance {
  readonly visible: boolean
  readonly opacity: number
  readonly order: number
  readonly color?: string | undefined
}

export interface LayerState extends LayerAppearance {
  readonly id: string
  readonly label: string
  /** Colour the layer was set with; shown in the panel until the user overrides it. */
  readonly baseColor: string
}

export const DEFAULT_APPEARANCE: LayerAppearance = { visible: true, opacity: 1, order: 0 }

/**
 * User-facing state of every overlay layer (visibility, colour, opacity, draw order), kept outside the panel so it
 * survives remounts and is shared by the layers panel and the surface. Higher `order` draws on top.
 */
export class LayerStore {
  private layers = new Map<string, LayerState>()
  private readonly listeners = new Set<() => void>()

  /** Layers sorted bottom to top. */
  list(): ReadonlyArray<LayerState> {
    return [...this.layers.values()].sort((a, b) => a.order - b.order)
  }

  get(id: string): LayerState | undefined { return this.layers.get(id) }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Registers a layer on first sight (new layers go on top); later calls only refresh label and base colour. */
  ensure(id: string, info: { readonly label?: string; readonly baseColor: string }) {
    const old = this.layers.get(id)
    if (old) {
      const label = info.label ?? old.label
      if (label === old.label && info.baseColor === old.baseColor) return
      this.layers.set(id, { ...old, label, baseColor: info.baseColor })
    } else {
      const top = Math.max(-1, ...[...this.layers.values()].map((l) => l.order))
      this.layers.set(id, { ...DEFAULT_APPEARANCE, id, label: info.label ?? id, baseColor: info.baseColor, order: top + 1 })
    }
    this.emit()
  }

  drop(id: string) {
    if (this.layers.delete(id)) this.emit()
  }

  patch(id: string, p: Partial<Pick<LayerAppearance, "visible" | "opacity" | "color">>) {
    const old = this.layers.get(id)
    if (!old) return
    const next: LayerState = {
      ...old,
      ...(p.visible !== undefined ? { visible: p.visible } : {}),
      ...(p.opacity !== undefined ? { opacity: Math.min(1, Math.max(0, p.opacity)) } : {}),
      ...("color" in p ? { color: p.color } : {})
    }
    this.layers.set(id, next)
    this.emit()
  }

  /** Moves a layer one step up (`+1`, drawn later) or down (`-1`) by swapping order with its neighbour. */
  move(id: string, delta: 1 | -1) {
    const sorted = this.list()
    const i = sorted.findIndex((l) => l.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= sorted.length) return
    const a = sorted[i]!, b = sorted[j]!
    this.layers.set(a.id, { ...a, order: b.order })
    this.layers.set(b.id, { ...b, order: a.order })
    this.emit()
  }

  appearance(id: string): LayerAppearance {
    const l = this.layers.get(id)
    return l ? { visible: l.visible, opacity: l.opacity, order: l.order, color: l.color } : DEFAULT_APPEARANCE
  }

  private emit() { for (const fn of [...this.listeners]) fn() }
}
