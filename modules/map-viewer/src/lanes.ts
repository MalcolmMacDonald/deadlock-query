/**
 * Lane colours as the game shows them. Entities carry a lane number: 1 Yellow, 2 Blue (the middle lane), 3 Green.
 * The game's own data calls the Green lane "purple"; there is no purple lane here.
 */
export type LaneName = "yellow" | "blue" | "green"

export const LANE_NAMES: ReadonlyArray<LaneName> = ["yellow", "blue", "green"]

export const LANE_STYLE: Readonly<Record<LaneName, { readonly label: string; readonly color: string }>> = {
  yellow: { label: "Yellow", color: "#f2c230" },
  blue: { label: "Blue", color: "#3b7bff" },
  green: { label: "Green", color: "#2fd673" }
}

/** Lane colour of a lane number (1-3), `undefined` for anything else. */
export const laneName = (n: unknown): LaneName | undefined => (n === 1 || n === 2 || n === 3 ? LANE_NAMES[n - 1] : undefined)

/** `Yellow lane` for lane 1, `lane 5` for a number that is not one of the three colours. */
export const laneLabel = (n: number): string => {
  const name = laneName(n)
  return name ? `${LANE_STYLE[name].label} lane` : `lane ${n}`
}

/**
 * Lane of a Hammer `color_tint` (`[r, g, b]`): orange is Yellow, blue is Blue, magenta/purple is Green; greys and
 * whites have none. Used for ziplines of a bundle that predates the extractor setting `lane` on them.
 */
export const laneFromTint = (tint: unknown): LaneName | undefined => {
  if (!Array.isArray(tint) || tint.length < 3 || !tint.slice(0, 3).every((c) => typeof c === "number")) return undefined
  const [r, g, b] = (tint as number[]).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (max === 0 || d / max < 0.25) return undefined
  const h = max === r ? (((g - b) / d) % 6) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  const hue = (h + 360) % 360
  if (hue >= 15 && hue < 75) return "yellow"
  if (hue >= 180 && hue < 265) return "blue"
  if (hue >= 265 && hue < 340) return "green"
  return undefined
}
