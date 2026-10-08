import type { Comment } from "./github.ts"

/** Feedback comments re-trigger the agent on the same branch, so they always start with `@claude`. */
export const feedbackBody = (text: string): string | undefined => {
  const t = text.trim()
  if (t === "") return undefined
  return /^@claude\b/.test(t) ? t : `@claude ${t}`
}

/** Sums "<n> tokens" mentions in Claude's comments (thousands separators allowed; `12k` counts as 12000). */
export const tokenTotal = (comments: ReadonlyArray<Comment>): number => {
  let total = 0
  for (const c of comments) {
    for (const m of c.body.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?\s+tokens\b/g)) {
      const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)
      if (Number.isFinite(n)) total += n
    }
  }
  return Math.round(total)
}

/** Tab title with a badge when cards wait in Review. */
export const titleBadge = (base: string, reviewCount: number): string => (reviewCount > 0 ? `(${reviewCount}) ${base}` : base)
