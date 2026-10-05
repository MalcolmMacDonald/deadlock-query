import { sessionCookie, signSession, verifyPassword } from "../../modules/infra/src/auth.ts"

interface Env { DEV_PASSWORD_HASH: string; SESSION_HMAC_KEY: string }

/** Every failed attempt waits this long (wall time is free on Workers), which slows sequential guessing. */
const FAIL_DELAY_MS = 1000

const page = (msg = "") =>
  `<!doctype html><meta charset="utf-8"><title>Dev login</title><form method="post" action="/auth/login"><h1>Deadlock Query (dev)</h1>${msg ? `<p>${msg}</p>` : ""}<input type="password" name="password" autofocus autocomplete="current-password"> <button>Log in</button></form>`
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })

export const onRequestGet: PagesFunction<Env> = async () => html(page())

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const password = String((await request.formData()).get("password") ?? "")
  if (!(await verifyPassword(password, env.DEV_PASSWORD_HASH))) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS))
    return html(page("Wrong password."), 401)
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": sessionCookie(await signSession(env.SESSION_HMAC_KEY)) },
  })
}
