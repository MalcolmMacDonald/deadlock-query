/** Reports how far a download is: `total` is unknown when the server compresses or does not say. */
export type ReportProgress = (loaded: number, total?: number) => void

/** Something the panel needs before it can start: a value, a promise, or a function that reports progress while it loads. */
export type Loadable<T> = T | Promise<T> | ((report: ReportProgress) => Promise<T>)

export const resolveLoadable = <T>(l: Loadable<T>, report: ReportProgress): Promise<T> =>
  Promise.resolve(typeof l === "function" ? (l as (r: ReportProgress) => Promise<T>)(report) : l)

/**
 * `fetch` + JSON with download progress. With `Content-Encoding` (gzip/br) the body length seen here
 * is the decoded size while `Content-Length` is the encoded one, so no total is reported then.
 */
export const fetchJsonWithProgress = async <T>(url: string, report?: ReportProgress, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const encoded = (res.headers.get("content-encoding") ?? "identity") !== "identity"
  const length = Number(res.headers.get("content-length"))
  const total = !encoded && Number.isFinite(length) && length > 0 ? length : undefined
  if (!res.body || !report) return (await res.json()) as T
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    report(loaded, total)
  }
  const bytes = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.length }
  report(loaded, loaded)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

const cache = new Map<string, Promise<unknown>>()

/**
 * Memoised JSON download: the same URL is fetched once per page (re-opening the panel, or a prefetch
 * followed by the real mount, costs nothing). Failures are not cached, so Retry works.
 */
export const fetchJsonCached = <T>(url: string, report?: ReportProgress): Promise<T> => {
  const hit = cache.get(url) as Promise<T> | undefined
  if (hit) return hit.then((v) => { report?.(1, 1); return v })
  const p = fetchJsonWithProgress<T>(url, report)
  cache.set(url, p)
  p.catch(() => { if (cache.get(url) === p) cache.delete(url) })
  return p
}
