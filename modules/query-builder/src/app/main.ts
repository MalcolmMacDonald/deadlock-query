import { fetchLibraryArtifact, fetchQueryBundle, mountQueryEditor } from "../panel/loader.ts"
import { makeStandaloneServices } from "./standaloneServices.ts"

// Standalone app: the panel against a recording viewer and in-memory selection (no other module required).
const host = makeStandaloneServices()
const handle = await mountQueryEditor(document.getElementById("root")!, {
  library: fetchLibraryArtifact("library.json"),
  bundle: fetchQueryBundle("bundle.json"),
  viewer: host.viewer,
  selection: host.selection,
  initialShare: location.hash
})
;(self as any).__qb = { editor: handle.editor, run: handle.run, cancel: handle.cancel, runner: handle.runner, store: handle.store, shareUrl: handle.shareUrl, host }
