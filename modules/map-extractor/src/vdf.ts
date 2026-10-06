/** Minimal Valve KeyValues (VDF/ACF) text parser: nested `"key" "value"` / `"key" { ... }`. */
export type Vdf = { [key: string]: string | Vdf }

const tokens = (src: string): string[] => {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1] !== undefined) out.push(`s${m[1].replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c))}`)
    else if (m[2]) out.push(m[2])
  }
  return out
}

export const parseVdf = (src: string): Vdf => {
  const t = tokens(src)
  let i = 0
  const block = (): Vdf => {
    const o: Vdf = {}
    while (i < t.length && t[i] !== "}") {
      const k = t[i++]!
      if (!k.startsWith("s")) throw new Error(`VDF: expected key, got ${k}`)
      const v = t[i++]
      if (v === "{") { o[k.slice(1)] = block(); if (t[i++] !== "}") throw new Error("VDF: unterminated block") }
      else if (v?.startsWith("s")) o[k.slice(1)] = v.slice(1)
      else throw new Error("VDF: missing value")
    }
    return o
  }
  const r = block()
  if (i < t.length) throw new Error("VDF: unbalanced braces")
  return r
}
