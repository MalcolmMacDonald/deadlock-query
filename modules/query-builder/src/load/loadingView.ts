export interface LoadingStep {
  /** Download progress for this step; without `total` the bar is indeterminate. */
  readonly progress: (loaded: number, total?: number) => void
  readonly done: () => void
}

export interface LoadingView {
  readonly el: HTMLElement
  readonly step: (id: string, label: string) => LoadingStep
  readonly phase: (text: string) => void
  readonly fail: (message: string, retry: () => void) => void
  /** Clears the steps (before a retry). */
  readonly reset: () => void
}

const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`)

/** What people see while the editor, library and map load: one labelled progress bar per step. */
export const renderLoadingView = (doc: Document): LoadingView => {
  const el = doc.createElement("div")
  el.className = "qb-loading"
  el.dataset.testid = "loading"
  el.setAttribute("role", "status")
  el.setAttribute("aria-live", "polite")
  Object.assign(el.style, { position: "absolute", inset: "0", zIndex: "1", display: "flex", flexDirection: "column", gap: "10px", justifyContent: "center", alignItems: "center", background: "#1e1e1e", color: "#ddd", font: "13px system-ui,sans-serif", padding: "16px" })
  const headline = doc.createElement("div")
  headline.textContent = "Loading the query editor…"
  const list = doc.createElement("div")
  Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "6px", minWidth: "240px", maxWidth: "100%" })
  el.append(headline, list)
  return {
    el,
    phase: (text) => { headline.textContent = text },
    step: (id, label) => {
      const row = doc.createElement("label")
      row.dataset.step = id
      const text = doc.createElement("span")
      text.textContent = label
      const bar = doc.createElement("progress")
      bar.max = 1
      bar.style.width = "100%"
      bar.setAttribute("aria-label", label)
      row.append(text, bar)
      row.style.display = "flex"
      row.style.flexDirection = "column"
      list.append(row)
      return {
        progress: (loaded, total) => {
          if (total && total > 0) { bar.value = Math.min(1, loaded / total); text.textContent = `${label} (${fmtBytes(loaded)} of ${fmtBytes(total)})` }
          else { bar.removeAttribute("value"); text.textContent = `${label} (${fmtBytes(loaded)})` }
        },
        done: () => { bar.value = 1; text.textContent = `${label} ✓`; row.dataset.done = "true" }
      }
    },
    reset: () => { list.replaceChildren(); headline.textContent = "Loading the query editor…" },
    fail: (message, retry) => {
      headline.textContent = "The query editor failed to load."
      const err = doc.createElement("pre")
      err.dataset.testid = "loading-error"
      err.textContent = message
      err.style.whiteSpace = "pre-wrap"
      err.style.color = "#f48771"
      const b = doc.createElement("button")
      b.type = "button"
      b.textContent = "Retry"
      b.dataset.testid = "loading-retry"
      b.addEventListener("click", retry)
      list.replaceChildren(err, b)
    }
  }
}
