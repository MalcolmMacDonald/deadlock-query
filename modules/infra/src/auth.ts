/** Dev-site auth primitives (WebCrypto only, so they run in Workers and Bun). */

const enc = new TextEncoder()
const ITERATIONS = 100_000 // Workers WebCrypto caps PBKDF2 at 100k
export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const COOKIE_NAME = "dlq_session"

const hex = (b: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)))

/** Length-independent constant-time comparison. */
export const safeEqual = (a: string, b: string): boolean => {
  const x = enc.encode(a), y = enc.encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}

const pbkdf2 = async (password: string, salt: Uint8Array, iterations: number): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256))
}

/** Returns `pbkdf2$<iterations>$<saltHex>$<hashHex>`. */
export const hashPassword = async (password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> =>
  `pbkdf2$${ITERATIONS}$${hex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [kind, iters, salt, hash] = stored.split("$")
  if (kind !== "pbkdf2" || !iters || !salt || !hash) return false
  const n = Number(iters)
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return false
  return safeEqual(await pbkdf2(password, unhex(salt), n), hash)
}

const hmac = async (key: string, msg: string): Promise<string> => {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))
}

/** Cookie value `<expiresEpochSeconds>.<hmac>`. */
export const signSession = async (key: string, now = Date.now()): Promise<string> => {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${exp}.${await hmac(key, exp)}`
}

export const verifySession = async (key: string, value: string | undefined, now = Date.now()): Promise<boolean> => {
  if (!value) return false
  const [exp, sig] = value.split(".")
  if (!exp || !sig || !/^\d+$/.test(exp)) return false
  if (!safeEqual(await hmac(key, exp), sig)) return false
  return Number(exp) * 1000 > now
}

export const readCookie = (header: string | null, name = COOKIE_NAME): string | undefined =>
  header?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1)

export const sessionCookie = (value: string, maxAge = SESSION_TTL_SECONDS): string =>
  `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`

/** Fixed-window login rate limiter (per isolate; best-effort, see docs/dev-site.md). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max = 5, private readonly windowMs = 60_000) {}
  /** True if the attempt is allowed; counts it. */
  allow(id: string, now = Date.now()): boolean {
    const h = this.hits.get(id)
    if (!h || h.reset <= now) { this.hits.set(id, { n: 1, reset: now + this.windowMs }); return true }
    h.n++
    return h.n <= this.max
  }
}
