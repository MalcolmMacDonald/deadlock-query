import { DevAuth } from "@deadlock-query/contracts"
import { Effect, Layer } from "effect"

/** Browser `DevAuth` backed by the dev site's `/auth/*` functions (session cookie is HttpOnly, so we ask the server). */
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
