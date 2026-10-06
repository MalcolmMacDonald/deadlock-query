import { useEffect, useSyncExternalStore } from "react"
import { toastDuration, toastStore, type Toast } from "./toasts.ts"

const ToastView = ({ toast }: { toast: Toast }) => {
  // Re-raising an identical toast (count changes) restarts its timer.
  useEffect(() => {
    const t = setTimeout(() => toastStore.dismiss(toast.id), toastDuration(toast.kind))
    return () => clearTimeout(t)
  }, [toast.id, toast.kind, toast.count])
  return (
    <div className="toast" data-testid="toast" data-kind={toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
      <span className="message">{toast.message}{toast.count > 1 && <span className="count"> (×{toast.count})</span>}</span>
      <button type="button" aria-label="Dismiss notification" onClick={() => toastStore.dismiss(toast.id)}>×</button>
    </div>
  )
}

/** Bottom-right stack of toasts. Errors use `role="alert"`, the rest `role="status"`, so screen readers announce them. */
export const Toaster = () => {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.list)
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => <ToastView key={t.id} toast={t} />)}
    </div>
  )
}
