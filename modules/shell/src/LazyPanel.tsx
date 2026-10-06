import type { IDockviewPanelProps } from "dockview"
import { type ReactNode, useEffect, useState } from "react"

/** Renders `children` only once the dockview panel has been visible, so hidden tabs never pay for heavy content (e.g. Monaco). */
export const LazyPanel = ({ api, children }: { api: IDockviewPanelProps["api"]; children: () => ReactNode }) => {
  const [seen, setSeen] = useState(api.isVisible)
  useEffect(() => {
    if (seen) return
    const d = api.onDidVisibilityChange((e) => e.isVisible && setSeen(true))
    return () => d.dispose()
  }, [api, seen])
  return seen ? <>{children()}</> : <div style={{ padding: 12 }}>Loading…</div>
}
