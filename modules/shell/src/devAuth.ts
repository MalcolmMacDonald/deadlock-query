import { DevAuth, MockDevAuth } from "@deadlock-query/contracts"
import { Effect, Layer } from "effect"

/**
 * Browser `DevAuth` backed by the dev site's `/auth/*` Pages functions (infra M4). The session cookie is HttpOnly, so the
 * shell asks the server. Same protocol as infra's `DevAuthLive`; kept here because the shell may not import infra.
 */
export const DevAuthLive = (fetchFn: typeof fetch = fetch, base = ""): Layer.Layer<DevAuth> =>
  Layer.succeed(DevAuth)({
    status: Effect.promise(async () => {
      try {
        return (await fetchFn(`${base}/auth/session`, { credentials: "same-origin" })).ok ? "authenticated" : "anonymous"
      } catch {
        return "anonymous"
      }
    }),
    login: (password) =>
      Effect.promise(async () => {
        try {
          const res = await fetchFn(`${base}/auth/login`, {
            method: "POST",
            body: new URLSearchParams({ password }),
            credentials: "same-origin",
            redirect: "manual",
          })
          return res.status === 303 || res.type === "opaqueredirect" || res.ok
        } catch {
          return false
        }
      }),
  })

/** `vite dev` has no `/auth/*` functions, so it runs as always-authenticated; deployed builds talk to the server. */
export const appDevAuthLayer: Layer.Layer<DevAuth> = import.meta.env?.DEV ? MockDevAuth : DevAuthLive()
