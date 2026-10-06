import type { ExportFormat } from "../export/exports.ts"

export interface ExportBarOptions {
  readonly provisional: boolean
  readonly onExport: (format: ExportFormat) => void
  readonly onPng: () => void
  readonly onCopy: (format: "csv" | "json") => void
}

/** Export buttons shown above a result. Stateless: the panel re-renders it with the table. */
export const renderExportBar = (doc: Document, opts: ExportBarOptions): HTMLElement => {
  const bar = doc.createElement("div")
  bar.className = "export-bar"
  bar.dataset.testid = "export-bar"
  const add = (label: string, testid: string, title: string, onClick: () => void) => {
    const b = doc.createElement("button")
    b.type = "button"
    b.textContent = label
    b.title = title
    b.dataset.testid = testid
    b.addEventListener("click", onClick)
    bar.append(b)
  }
  bar.append(Object.assign(doc.createElement("span"), { textContent: "Export:" }))
  add("CSV", "export-csv", "Table as CSV", () => opts.onExport("csv"))
  add("JSON", "export-json", "Full result as JSON, with metadata", () => opts.onExport("json"))
  add("GeoJSON", "export-geojson", "Geometry columns as GeoJSON (Source world units, not WGS84)", () => opts.onExport("geojson"))
  add("Annotations", "export-annotations", "Geometry columns as an annotation document for the viewer", () => opts.onExport("annotations"))
  add("PNG", "export-png", "Screenshot of the map view", opts.onPng)
  add("Copy CSV", "copy-csv", "Copy the table as CSV", () => opts.onCopy("csv"))
  add("Copy JSON", "copy-json", "Copy the full result as JSON", () => opts.onCopy("json"))
  if (opts.provisional) {
    const note = doc.createElement("span")
    note.className = "provisional"
    note.dataset.testid = "provisional-note"
    note.textContent = "Provisional: exports are marked as such."
    bar.append(note)
  }
  return bar
}
