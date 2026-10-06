export type ToastKind = "info" | "success" | "error"

export interface Toast {
  readonly id: number
  readonly kind: ToastKind
  readonly message: string
  /** How many times this exact toast was raised while still on screen (repeats collapse instead of stacking). */
  readonly count: number
}

export interface ToastStore {
  readonly list: () => ReadonlyArray<Toast>
  readonly subscribe: (listener: () => void) => () => void
  readonly push: (kind: ToastKind, message: string) => number
  readonly dismiss: (id: number) => void
}

/** A tiny external store (for `useSyncExternalStore`): newest last, at most `max` kept, identical toasts collapse into a count. */
export const createToastStore = (max = 5): ToastStore => {
  let toasts: ReadonlyArray<Toast> = []
  let nextId = 1
  const listeners = new Set<() => void>()
  const set = (next: ReadonlyArray<Toast>) => {
    toasts = next
    for (const l of [...listeners]) l()
  }
  return {
    list: () => toasts,
    subscribe: (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    push: (kind, message) => {
      const same = toasts.find((t) => t.kind === kind && t.message === message)
      if (same) {
        set(toasts.map((t) => (t === same ? { ...t, count: t.count + 1 } : t)))
        return same.id
      }
      const id = nextId++
      set([...toasts, { id, kind, message, count: 1 }].slice(-max))
      return id
    },
    dismiss: (id) => set(toasts.filter((t) => t.id !== id)),
  }
}

/** The app-wide store behind `notify`. */
export const toastStore = createToastStore()
export const notify = (kind: ToastKind, message: string): number => toastStore.push(kind, message)

/** Milliseconds a toast stays before dismissing itself; errors stay longer and are announced assertively. */
export const toastDuration = (kind: ToastKind): number => (kind === "error" ? 12000 : 4000)
