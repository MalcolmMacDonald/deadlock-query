import { expect, test } from "bun:test"
import { applyTheme, loadTheme, nextTheme, parseTheme, saveTheme, THEME_KEY } from "../src/theme.ts"

test("dark is the default; only a stored light switches", () => {
  expect(parseTheme(null)).toBe("dark")
  expect(parseTheme("light")).toBe("light")
  expect(parseTheme("sepia")).toBe("dark")
  expect(nextTheme("dark")).toBe("light")
  expect(nextTheme("light")).toBe("dark")
})

test("theme round-trips through storage and survives a throwing store", () => {
  const m = new Map<string, string>()
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  saveTheme(store, "light")
  expect(m.get(THEME_KEY)).toBe("light")
  expect(loadTheme(store)).toBe("light")
  const broken = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } }
  expect(loadTheme(broken)).toBe("dark")
  expect(() => saveTheme(broken, "light")).not.toThrow()
})

test("theme applies to the document", () => {
  const doc = { documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> } } as unknown as Document
  applyTheme(doc, "light")
  expect(doc.documentElement.dataset.theme).toBe("light")
  expect(doc.documentElement.style.colorScheme).toBe("light")
})
