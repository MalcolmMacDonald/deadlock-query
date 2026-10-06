/**
 * Package entry. Embeddable query editor panel: the shell supplies the real `ViewerService` and
 * `SelectionBus` and mounts it. Browser-only and heavy (Monaco): import it lazily.
 */
export { makeQueryEditorPanel, mountQueryEditor } from "./panel/QueryEditorPanel.ts"
export type { QueryBundle, QueryEditorHandle, QueryEditorPanelOptions, SelectionBusShape, ViewerServiceShape } from "./panel/QueryEditorPanel.ts"
export { checkApiVersion, decodeShare, encodeShare } from "./share/shareLink.ts"
export type { ApiVersionCheck, SharedQuery } from "./share/shareLink.ts"
export { buildExport, resultToAnnotations } from "./export/exports.ts"
export type { ExportFile, ExportFormat, ExportMeta } from "./export/exports.ts"
export type { LibraryArtifact } from "./engine/prelude.ts"

/** Fetches a `library.json` (as written next to the standalone app, e.g. `./editor/library.json`). */
export const fetchLibraryArtifact = async (url: string): Promise<import("./engine/prelude.ts").LibraryArtifact> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`library artifact ${url}: HTTP ${r.status}`)
  return (await r.json()) as import("./engine/prelude.ts").LibraryArtifact
}
