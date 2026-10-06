import { mountQueryEditor } from "../panel/QueryEditorPanel.ts"
import type { LibraryArtifact } from "../engine/prelude.ts"
import { makeStandaloneServices } from "./standaloneServices.ts"

// Standalone app: the panel against a recording viewer and in-memory selection (no other module required).
const [library, bundle] = await Promise.all([
  fetch("library.json").then((r) => r.json() as Promise<LibraryArtifact>),
  fetch("bundle.json").then((r) => r.json())
])
const host = makeStandaloneServices()
const handle = await mountQueryEditor(document.getElementById("root")!, { library, bundle, viewer: host.viewer, selection: host.selection })
;(self as any).__qb = { editor: handle.editor, run: handle.run, cancel: handle.cancel, runner: handle.runner, host }
