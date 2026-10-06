import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { DevAuth } from "@deadlock-query/contracts"
import { DevAuthLive } from "../src/devAuth.ts"

const run = <A>(fetchFn: typeof fetch, f: (a: (typeof DevAuth)["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* f(yield* DevAuth) }).pipe(Effect.provide(DevAuthLive(fetchFn, "https://dev.test"))))
const respond = (r: Partial<Response>) => (async () => r as Response) as unknown as typeof fetch
const failing = (async () => { throw new Error("offline") }) as unknown as typeof fetch

test("status reflects /auth/session and fails closed", async () => {
  let url = ""
  const spy = (async (u: string) => { url = u; return { ok: true } as Response }) as unknown as typeof fetch
  expect(await run(spy, (a) => a.status)).toBe("authenticated")
  expect(url).toBe("https://dev.test/auth/session")
  expect(await run(respond({ ok: false, status: 401 }), (a) => a.status)).toBe("anonymous")
  expect(await run(failing, (a) => a.status)).toBe("anonymous")
})

test("login posts the password and accepts the 303 / opaque redirect, rejecting 401 and network errors", async () => {
  const seen: { url?: string; init?: RequestInit } = {}
  const spy = (async (url: string, init?: RequestInit) => { seen.url = url; if (init) seen.init = init; return { ok: false, status: 303 } as Response }) as unknown as typeof fetch
  expect(await run(spy, (a) => a.login("hunter2"))).toBe(true)
  expect(seen.url).toBe("https://dev.test/auth/login")
  expect(seen.init?.method).toBe("POST")
  expect(String(seen.init?.body)).toBe("password=hunter2")
  expect(seen.init?.redirect).toBe("manual")
  expect(await run(respond({ ok: false, status: 0, type: "opaqueredirect" }), (a) => a.login("x"))).toBe(true)
  expect(await run(respond({ ok: false, status: 401 }), (a) => a.login("x"))).toBe(false)
  expect(await run(failing, (a) => a.login("x"))).toBe(false)
})
