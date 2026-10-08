/**
 * Package entry. Embeddable query editor panel: the shell supplies the real `ViewerService` and
 * `SelectionBus` and mounts it. This entry is deliberately light (a loader and a few pure helpers);
 * Monaco and the panel are a separate chunk fetched when a panel mounts or `prefetchQueryEditor` runs.
 */
export { fetchLibraryArtifact, fetchPublishedBundle, fetchQueryBundle, makeQueryEditorPanel, mountQueryEditor, prefetchQueryEditor } from "./panel/loader.ts"
export type { LazyQueryEditorPanelOptions } from "./panel/loader.ts"
export type { QueryBundle, QueryEditorHandle, QueryEditorPanelOptions, SelectionBusShape, ViewerServiceShape } from "./panel/QueryEditorPanel.ts"
export type { LibraryArtifact } from "./engine/prelude.ts"
export type { Loadable, ReportProgress } from "./load/progress.ts"
export { checkApiVersion, decodeShare, encodeShare } from "./share/shareLink.ts"
export type { ApiVersionCheck, SharedQuery } from "./share/shareLink.ts"
