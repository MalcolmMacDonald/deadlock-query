import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate"
import { parseLayout, serializeLayout } from "./layout.ts"

/** Hash parameter carrying a shared layout: `#layout=<base64url of the versioned stored layout>`. */
export const SHARE_PARAM = "layout"

/** Compressed links carry this marker before the payload; older links (plain base64url JSON) still decode. */
const COMPRESSED = "z."

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const fromBase64Url = (s: string): Uint8Array => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))

export const encodeLayoutHash = (layout: unknown): string =>
  `#${SHARE_PARAM}=${COMPRESSED}${toBase64Url(deflateSync(strToU8(serializeLayout(layout)), { level: 9 }))}`

/** The layout carried by a location hash, or null when absent, malformed, or from an unknown layout version. */
export const decodeLayoutHash = (hash: string): unknown | null => {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(SHARE_PARAM)
  if (!value) return null
  try {
    const bytes = value.startsWith(COMPRESSED) ? inflateSync(fromBase64Url(value.slice(COMPRESSED.length))) : fromBase64Url(value)
    return parseLayout(strFromU8(bytes))
  } catch {
    return null
  }
}

/** `href` with its hash replaced by the share fragment for `layout`. */
export const shareUrl = (href: string, layout: unknown): string => {
  const u = new URL(href)
  u.hash = encodeLayoutHash(layout)
  return u.toString()
}

/** `hash` without the layout parameter (other parameters, e.g. query-builder's `q=`, stay), as a `#…` string or "". */
export const withoutLayoutParam = (hash: string): string => {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  params.delete(SHARE_PARAM)
  const rest = params.toString()
  return rest ? `#${rest}` : ""
}
