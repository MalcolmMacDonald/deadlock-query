import { RateLimiter, kvCache, sessionCookie, signSession, verifyPassword } from "../../modules/infra/src/auth.ts"

interface Env { DEV_PASSWORD_HASH: string; SESSION_HMAC_KEY: string; RATE_LIMIT?: KVNamespace }

const page = (msg = "") =>
  `<!doctype html><meta charset="utf-8"><title>Dev login</title><form method="post" action="/auth/login"><h1>Deadlock Query (dev)</h1>${msg ? `<p>${msg}</p>` : ""}<input type="password" name="password" autofocus autocomplete="current-password"> <button>Log in</button></form>`
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })

export const onRequestGet: PagesFunction<Env> = async () => html(page())

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
  if (env.RATE_LIMIT && !(await new RateLimiter(kvCache(env.RATE_LIMIT)).allow(ip))) return html(page("Too many attempts. Try again in a minute."), 429)
  const password = String((await request.formData()).get("password") ?? "")
  if (!(await verifyPassword(password, env.DEV_PASSWORD_HASH))) return html(page("Wrong password."), 401)
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": sessionCookie(await signSession(env.SESSION_HMAC_KEY)) },
  })
}
