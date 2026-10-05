import { sessionCookie } from "../../modules/infra/src/auth.ts"

export const onRequestPost: PagesFunction = async () =>
  new Response(null, { status: 303, headers: { location: "/auth/login", "set-cookie": sessionCookie("", 0) } })
