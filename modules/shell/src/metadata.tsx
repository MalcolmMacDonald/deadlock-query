import { Effect, Layer } from "effect"
import { ViewerService, type ModuleDefinition } from "@deadlock-query/contracts"
import type { IDockviewPanelProps } from "dockview"
import { useEffect, useRef } from "react"
import { LazyPanel } from "./LazyPanel.tsx"
import { loadQueryBundle } from "./editor.tsx"
import { loadMetadataSupport } from "./metadataContext.ts"
import { BUNDLE_MANIFEST_URL } from "./viewer.ts"

type Viewer = (typeof ViewerService)["Service"]
let resolveViewer!: (v: Viewer) => void
const viewerReady = new Promise<Viewer>((resolve) => { resolveViewer = resolve })

/** Hands the runtime's shared `ViewerService` to the panel (it takes a value, not a layer). */
const captureViewer = Layer.effectDiscard(Effect.gen(function* () { resolveViewer(yield* ViewerService) }))

/** Mounts map-metadata's editor over the shared viewer; drafts live in IndexedDB, one database per map and build. */
const mountMetadata = (container: HTMLElement): (() => void) => {
  let dispose = () => {}
  let cancelled = false
  void Promise.all([import("@deadlock-query/map-metadata/editor"), viewerReady, loadQueryBundle()])
    .then(async ([md, viewer, { manifest }]) => {
      const drafts = await md.openDraftStore(md.indexedDbDraftStorage(`${manifest.mapName}:${manifest.gameBuildId}`))
      if (cancelled) return
      // Collision checks and accepted records come from the published bundle; without them the editor runs degraded.
      const support = await loadMetadataSupport(BUNDLE_MANIFEST_URL).catch(() => undefined)
      if (cancelled) return
      const context = () => ({
        expect: { mapName: manifest.mapName, gameBuildId: manifest.gameBuildId },
        ...(support ? { bounds: support.manifest.bounds, ...(support.collision ? { collision: support.collision } : {}), existing: support.accepted } : {}),
      })
      const controller = md.createEditorController({ viewer, drafts, context })
      if (support) controller.setAccepted(support.accepted)
      const panel = md.mountEditorPanel(container, controller)
      dispose = () => { panel.dispose(); controller.dispose() }
    })
    .catch((e) => {
      container.textContent = `Metadata editor failed to load: ${String(e)}`
    })
  return () => { cancelled = true; dispose() }
}

const MetadataHost = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => mountMetadata(ref.current!), [])
  return <div ref={ref} style={{ width: "100%", height: "100%", overflow: "auto" }} />
}

export const metadataModule: ModuleDefinition<ViewerService> = {
  id: "map-metadata",
  layer: captureViewer,
  panels: [
    {
      id: "metadata.editor",
      title: "Metadata",
      defaultPlacement: "right",
      component: ({ api }: IDockviewPanelProps) => <LazyPanel api={api}>{() => <MetadataHost />}</LazyPanel>,
    },
  ],
}
