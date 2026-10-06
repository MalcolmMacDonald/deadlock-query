import { expect, test } from "bun:test"
import { STYLE } from "../src/ui/styles.ts"

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex: string) => {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
}
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

// WCAG 2.1 AA: 4.5:1 for text, 3:1 for the focus ring and other UI boundaries. Pairs are the ones the stylesheet puts on screen.
const TEXT: ReadonlyArray<[fg: string, bg: string, where: string]> = [
  ["#ddd", "#1e1e1e", "body text"],
  ["#999", "#1e1e1e", "muted text, placeholders"],
  ["#f48771", "#1e1e1e", "errors"],
  ["#e2c08d", "#1e1e1e", "warnings, provisional note"],
  ["#ddd", "#2d2d30", "buttons and inputs"],
  ["#ddd", "#3a3a3d", "hovered button"],
  ["#f48771", "#2d2d30", "problems button with errors"],
  ["#e2c08d", "#2d2d30", "problems button with warnings"],
  ["#ddd", "#264f78", "selected row, active tab"],
  ["#ddd", "#2a2d2e", "hovered row"],
  ["#ddd", "#5a4a1a", "warning notice"],
  ["#ddd", "#5a1d1d", "error notice"],
  ["#ddd", "#1f3a52", "info notice"],
  ["#ddd", "#252526", "table header, code blocks"],
  ["#999", "#252526", "muted text on the table header"]
]
test.each(TEXT)("text %s on %s (%s) meets 4.5:1", (fg, bg) => {
  expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
})

test("the focus ring is visible against the panel and its controls (3:1)", () => {
  for (const bg of ["#1e1e1e", "#2d2d30", "#252526"]) expect(contrast("#4da3ff", bg)).toBeGreaterThanOrEqual(3)
})

test("every colour used in the contrast table is really in the stylesheet", () => {
  for (const hex of new Set(TEXT.flatMap(([fg, bg]) => [fg, bg]))) expect(STYLE.toLowerCase()).toContain(hex)
  expect(STYLE).toContain("#4da3ff")
})

test("the stylesheet honours forced colours, reduced motion and a visible keyboard focus", () => {
  expect(STYLE).toContain(":focus-visible")
  expect(STYLE).toContain("forced-colors")
  expect(STYLE).toContain("prefers-reduced-motion")
})
