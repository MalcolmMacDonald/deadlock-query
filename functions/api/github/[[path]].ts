import { checkBody, decide, sanitizeResponse, upstreamHeaders } from "../../../modules/infra/src/proxy.ts"

interface Env { GITHUB_TOKEN_PROXY?: string }

/** Session cookie is enforced by `functions/_middleware.ts`; this adds the allowlist and CSRF check. */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const d = decide(request.method, new URL(request.url), request.headers)
  if (!d.ok) return Response.json({ error: d.reason }, { status: d.status })
  if (!env.GITHUB_TOKEN_PROXY) return Response.json({ error: "proxy token not configured" }, { status: 503 })
  const hasBody = request.method !== "GET"
  const body = hasBody ? await request.text() : undefined
  if (body !== undefined) {
    const bad = checkBody(request.method, new URL(request.url).pathname.slice("/api/github".length), body)
    if (bad) return Response.json({ error: bad }, { status: 403 })
  }
  const res = await fetch(d.upstream, {
    method: request.method,
    headers: upstreamHeaders(env.GITHUB_TOKEN_PROXY, hasBody),
    body,
  })
  return sanitizeResponse(res)
}
