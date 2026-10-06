import { parseLayout, serializeLayout } from "./layout.ts"

/** Hash parameter carrying a shared layout: `#layout=<base64url of the versioned stored layout>`. */
export const SHARE_PARAM = "layout"

const toBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const fromBase64Url = (s: string): string => {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export const encodeLayoutHash = (layout: unknown): string => `#${SHARE_PARAM}=${toBase64Url(serializeLayout(layout))}`

/** The layout carried by a location hash, or null when absent, malformed, or from an unknown layout version. */
export const decodeLayoutHash = (hash: string): unknown | null => {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(SHARE_PARAM)
  if (!value) return null
  try {
    return parseLayout(fromBase64Url(value))
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
