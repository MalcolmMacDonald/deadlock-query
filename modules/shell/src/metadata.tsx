import { Effect, Layer } from "effect"
import { ViewerService, type ModuleDefinition } from "@deadlock-query/contracts"
import type { IDockviewPanelProps } from "dockview"
import { useEffect, useRef } from "react"
import { LazyPanel } from "./LazyPanel.tsx"
import { loadQueryBundle } from "./editor.tsx"
import { loadMetadataSupport } from "./metadataContext.ts"
import { BUNDLE_MANIFEST_URL, getViewerController } from "./viewer.ts"

type Viewer = (typeof ViewerService)["Service"]
let resolveViewer!: (v: Viewer) => void
const viewerReady = new Promise<Viewer>((resolve) => { resolveViewer = resolve })

/** Hands the runtime's shared `ViewerService` to the panel (it takes a value, not a layer). */
const captureViewer = Layer.effectDiscard(Effect.gen(function* () { resolveViewer(yield* ViewerService) }))

/** Mounts map-metadata's editor over the shared viewer; drafts live in IndexedDB, one database per map and build. */
const mountMetadata = (container: HTMLElement): (() => void) => {
  let dispose = () => {}
  let cancelled = false
  void Promise.all([import("@deadlock-query/map-metadata/editor"), viewerReady, loadQueryBundle(), getViewerController()])
    .then(async ([md, viewer, { manifest }, map]) => {
      const drafts = await md.openDraftStore(md.indexedDbDraftStorage(`${manifest.mapName}:${manifest.gameBuildId}`))
      if (cancelled) return
      // Collision checks and accepted records come from the published bundle; without them the editor runs degraded.
      const support = await loadMetadataSupport(BUNDLE_MANIFEST_URL).catch(() => undefined)
      if (cancelled) return
      const context = () => ({
        expect: { mapName: manifest.mapName, gameBuildId: manifest.gameBuildId },
        ...(support ? { bounds: support.manifest.bounds, ...(support.collision ? { collision: support.collision } : {}), existing: support.accepted } : {}),
      })
      const controller = md.createEditorController({ viewer, drafts, context, identity: () => ({ mapName: manifest.mapName, gameBuildId: manifest.gameBuildId }) })
      if (support) controller.setAccepted(support.accepted)
      // Tagging works on what is picked on the map: clicked entities become the tag controller's selection.
      const source = {
        selected: () => map.highlightedIds.flatMap((id) => {
          const e = map.entityForFeature(id)
          return e ? [{ id: e.id, position: e.position, label: e.class }] : []
        }),
        subscribe: (fn: () => void) => map.onHighlightChange(fn),
      }
      const tags = md.createTagController({ viewer, drafts, source })
      const panel = md.mountEditorPanel(container, controller, { tags })
      dispose = () => { panel.dispose(); tags.dispose(); controller.dispose() }
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
    {
      id: "metadata.history",
      title: "Metadata history",
      defaultPlacement: "right",
      component: ({ api }: IDockviewPanelProps) => <LazyPanel api={api}>{() => <HistoryHost />}</LazyPanel>,
    },
  ],
}

/** Mounts the reviewer panel (dev-only): submissions come through the dev proxy's GitHub routes, drawn over the shared viewer. */
const mountReview = (container: HTMLElement): (() => void) => {
  let dispose = () => {}
  let cancelled = false
  void Promise.all([import("@deadlock-query/map-metadata/editor"), viewerReady])
    .then(([md, viewer]) => {
      if (cancelled) return
      const controller = md.createReviewController({
        api: md.proxyApi(),
        viewer,
        reviewer: () => (container.querySelector<HTMLInputElement>("#dlq-rv-name")?.value ?? ""),
      })
      const panel = md.mountReviewPanel(container, controller)
      dispose = () => panel.dispose()
    })
    .catch((e) => {
      container.textContent = `Review panel failed to load: ${String(e)}`
    })
  return () => { cancelled = true; dispose() }
}

const ReviewHost = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => mountReview(ref.current!), [])
  return <div ref={ref} style={{ width: "100%", height: "100%", overflow: "auto" }} />
}

/** Reviewer tools: dev builds only (behind the lock screen), since they act through the dev GitHub proxy. */
export const metadataReviewModule: ModuleDefinition<ViewerService> = {
  id: "map-metadata-review",
  layer: Layer.empty,
  panels: [
    {
      id: "metadata.review",
      title: "Review submissions",
      defaultPlacement: "right",
      component: ({ api }: IDockviewPanelProps) => <LazyPanel api={api}>{() => <ReviewHost />}</LazyPanel>,
    },
  ],
}

/** Mounts the history panel: the audit trail of every record in the published `metadata.bundle.json`, click to fly there. */
const mountHistory = (container: HTMLElement): (() => void) => {
  let dispose = () => {}
  let cancelled = false
  void Promise.all([import("@deadlock-query/map-metadata/editor"), viewerReady, loadMetadataSupport(BUNDLE_MANIFEST_URL).catch(() => undefined)])
    .then(([md, viewer, support]) => {
      if (cancelled) return
      const records = support?.records ?? []
      const panel = md.mountHistoryPanel(container, () => records, (id) => {
        const at = records.find((r) => r.id === id)
        const p = at && "position" in at ? (at.position as readonly [number, number, number]) : undefined
        if (p) void Effect.runFork(viewer.flyTo([p[0], p[1], p[2]]))
      })
      dispose = () => panel.dispose()
    })
    .catch((e) => {
      container.textContent = `History panel failed to load: ${String(e)}`
    })
  return () => { cancelled = true; dispose() }
}

const HistoryHost = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => mountHistory(ref.current!), [])
  return <div ref={ref} style={{ width: "100%", height: "100%", overflow: "auto" }} />
}
