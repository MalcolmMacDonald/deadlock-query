/**
 * Share links: `#q=<deflate+base64url source>&api=<apiVersion>`. The fragment never leaves the browser
 * and a decoded link only fills the editor: it is never run automatically.
 */
export const MAX_SHARED_SOURCE_BYTES = 200_000

const toBase64Url = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
const fromBase64Url = (text: string): Uint8Array => {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

const pipe = async (input: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, maxBytes = Infinity): Promise<Uint8Array> => {
  const writer = stream.writable.getWriter()
  void writer.write(input).then(() => writer.close()).catch(() => {})
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    // A tiny hostile fragment can inflate enormously; stop at the cap instead of materialising it.
    if (total > maxBytes) { await reader.cancel(); throw new Error("The shared query is too large.") }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

export interface SharedQuery {
  readonly source: string
  /** The library `apiVersion` the link was made with (absent on hand-written links). */
  readonly apiVersion?: string
}

/** The fragment (without the leading `#`) for a query. */
export const encodeShare = async (q: SharedQuery): Promise<string> => {
  const packed = await pipe(new TextEncoder().encode(q.source), new CompressionStream("deflate-raw") as never)
  return `q=${toBase64Url(packed)}${q.apiVersion ? `&api=${encodeURIComponent(q.apiVersion)}` : ""}`
}

/** Parses a fragment (with or without `#`). `undefined` when it carries no query; throws on a damaged one. */
export const decodeShare = async (hash: string): Promise<SharedQuery | undefined> => {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const q = params.get("q")
  if (q === null) return undefined
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(await pipe(fromBase64Url(q), new DecompressionStream("deflate-raw") as never, MAX_SHARED_SOURCE_BYTES))
  } catch (e) {
    throw new Error(e instanceof Error && /too large/.test(e.message) ? e.message : "The share link is damaged and could not be read.")
  }
  const api = params.get("api")
  return { source, ...(api ? { apiVersion: api } : {}) }
}

export type ApiVersionCheck =
  | { readonly kind: "same" }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "older" | "newer" | "incompatible"; readonly message: string }

const parse = (v: string): [number, number, number] | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/**
 * Compares the library version a query was written against with the one loaded now. Anything but
 * `same` carries a message to show next to the query. SemVer: a major change may break it; a newer
 * link may call functions this library does not have yet; an older one only misses new features.
 */
export const checkApiVersion = (queryVersion: string | undefined, current: string): ApiVersionCheck => {
  if (queryVersion === undefined) return { kind: "unknown", message: "This query does not say which library version it was written for; check that it still type-checks." }
  if (queryVersion === current) return { kind: "same" }
  const a = parse(queryVersion), b = parse(current)
  if (!a || !b) return { kind: "unknown", message: `Written for library ${queryVersion}; the loaded library is ${current}.` }
  if (a[0] !== b[0]) return { kind: "incompatible", message: `Written for library ${queryVersion}, but the loaded library is ${current} (a different major version): functions may have changed or been removed.` }
  const newer = a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])
  return newer
    ? { kind: "newer", message: `Written for a newer library (${queryVersion}; loaded ${current}): it may call functions that do not exist here yet.` }
    : { kind: "older", message: `Written for an older library (${queryVersion}; loaded ${current}): it should still run, but check the results.` }
}
