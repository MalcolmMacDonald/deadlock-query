import { notify, type ToastKind } from "./toasts.ts"

type Notify = (kind: ToastKind, message: string) => unknown
type ErrorTarget = Pick<Window, "addEventListener" | "removeEventListener">

const describe = (reason: unknown): string =>
  reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "An unexpected error occurred."

/** Browser noise that is not actionable for the user. */
const ignorable = (message: string): boolean => /ResizeObserver loop/i.test(message)

/** Surfaces uncaught errors and unhandled promise rejections as error toasts. Returns an uninstall function. */
export const installGlobalErrorToasts = (target: ErrorTarget = window, push: Notify = notify): (() => void) => {
  const onError = (e: Event) => {
    const { error, message } = e as ErrorEvent
    const text = describe(error ?? message)
    if (!ignorable(text)) push("error", `Unexpected error: ${text}`)
  }
  const onRejection = (e: Event) => {
    const text = describe((e as PromiseRejectionEvent).reason)
    if (!ignorable(text)) push("error", `Unexpected error: ${text}`)
  }
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)
  return () => {
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
  }
}
