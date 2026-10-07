import { handleRequest, type Env } from "./handler.ts"

/** Cloudflare Worker entry: `bunx wrangler dev` in this directory. Secrets: see `wrangler.toml` and `docs/secrets.md`. */
export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env)
}
