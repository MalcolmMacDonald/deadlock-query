import { COOKIE_NAME, readCookie, verifySession } from "../modules/infra/src/auth.ts"

interface Env { SESSION_HMAC_KEY: string }

/** Every request needs a valid session cookie except the login endpoints. */
export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url)
  if (url.pathname === "/auth/login" || url.pathname === "/auth/logout") return ctx.next()
  if (await verifySession(ctx.env.SESSION_HMAC_KEY, readCookie(ctx.request.headers.get("cookie"), COOKIE_NAME))) return ctx.next()
  const wantsHtml = ctx.request.method === "GET" && (ctx.request.headers.get("accept") ?? "").includes("text/html")
  if (wantsHtml) return Response.redirect(`${url.origin}/auth/login`, 302)
  return new Response("Unauthorized", { status: 401 })
}
