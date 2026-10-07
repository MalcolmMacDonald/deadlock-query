/** The live submission service: the deployed worker and the Turnstile widget's public site key (not a secret). */
export interface SubmitService { readonly url: string; readonly siteKey: string }

export const DEFAULT_SUBMIT_SERVICE: SubmitService = {
  url: "https://deadlock-query-submit.m-51c.workers.dev/submit",
  siteKey: "0x4AAAAAAFP9quRtWFXGGRRn"
}

type TurnstileApi = { render: (el: HTMLElement, o: { sitekey: string; callback: (t: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string; reset: (id?: string) => void }

/** Renders the human check into `el`; resolves to a `reset`. `onToken(undefined)` means the token expired or the widget failed. */
export type RenderTurnstile = (el: HTMLElement, siteKey: string, onToken: (token: string | undefined) => void) => Promise<{ readonly reset: () => void }>

let loading: Promise<TurnstileApi> | undefined
const load = (): Promise<TurnstileApi> => loading ??= new Promise((resolve, reject) => {
  const w = window as unknown as { turnstile?: TurnstileApi }
  if (w.turnstile) return resolve(w.turnstile)
  const s = document.createElement("script")
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  s.async = true
  s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("Turnstile did not start")))
  s.onerror = () => { loading = undefined; reject(new Error("Could not load the human check")) }
  document.head.append(s)
})

export const renderTurnstile: RenderTurnstile = async (el, siteKey, onToken) => {
  const t = await load()
  const id = t.render(el, { sitekey: siteKey, callback: (tok) => onToken(tok), "expired-callback": () => onToken(undefined), "error-callback": () => onToken(undefined) })
  return { reset: () => { onToken(undefined); t.reset(id) } }
}
