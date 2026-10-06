import { Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import type { IDockviewPanelProps } from "dockview"
import { LazyPanel } from "./LazyPanel.tsx"

/** Query editor + results, served as a sibling static app at `editor/` (built by tools/build.ts) so Monaco stays out of the shell's initial JS. */
export const editorModule: ModuleDefinition = {
  id: "query-builder",
  layer: Layer.empty,
  panels: [
    {
      id: "query.editor",
      title: "Query",
      defaultPlacement: "right",
      component: ({ api }: IDockviewPanelProps) => (
        <LazyPanel api={api}>
          {() => <iframe title="Query editor" src="./editor/index.html" style={{ width: "100%", height: "100%", border: 0 }} />}
        </LazyPanel>
      ),
    },
  ],
}
