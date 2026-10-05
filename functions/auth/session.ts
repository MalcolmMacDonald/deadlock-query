import { COOKIE_NAME, readCookie, verifySession } from "../../modules/infra/src/auth.ts"

interface Env { SESSION_HMAC_KEY: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const ok = await verifySession(env.SESSION_HMAC_KEY, readCookie(request.headers.get("cookie"), COOKIE_NAME))
  return Response.json({ authenticated: ok }, { status: ok ? 200 : 401 })
}
