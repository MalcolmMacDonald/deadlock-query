/** Result of `POST /submit` on the submit worker, with the worker's error codes mapped to something a contributor can act on. */
export type PostResult =
  | { readonly ok: true; readonly id: string; readonly url: string }
  | { readonly ok: false; readonly status: number; readonly message: string; readonly issues?: ReadonlyArray<{ readonly code: string; readonly message: string }> }

const FRIENDLY: Readonly<Record<string, string>> = {
  "rate-limited": "Too many submissions from here. Try again in an hour, or use the download fallback.",
  github: "The submission could not be saved. Use the download fallback instead.",
  "too-large": "The submission is too large. Split it into smaller ones."
}

/** Sends the submission file text (`submissionFile(s).text`) to the worker. Network failures are reported, never thrown. */
export const postSubmission = async (
  text: string,
  opts: { readonly url: string; readonly fetch?: typeof fetch }
): Promise<PostResult> => {
  const f = opts.fetch ?? fetch
  let res: Response
  try {
    res = await f(opts.url, { method: "POST", body: text, headers: { "content-type": "application/json" } })
  } catch {
    return { ok: false, status: 0, message: "Could not reach the submission service. Use the download fallback instead." }
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { code?: string; message?: string; issues?: Array<{ code: string; message: string }> } }
  if (res.ok && body.id && body.url) return { ok: true, id: body.id, url: body.url }
  const code = body.error?.code ?? ""
  return { ok: false, status: res.status, message: FRIENDLY[code] ?? body.error?.message ?? `The service answered ${res.status}.`, ...(body.error?.issues ? { issues: body.error.issues } : {}) }
}
