import { Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"

const Dummy = ({ name }: { name: string }) => (
  <div style={{ padding: 12 }}>
    <h3>{name}</h3>
    <p>Placeholder panel from a dummy module.</p>
  </div>
)

export const dummyAlpha: ModuleDefinition = {
  id: "dummy-alpha",
  layer: Layer.empty,
  panels: [
    { id: "alpha", title: "Alpha", component: () => <Dummy name="Alpha" />, defaultPlacement: "left" },
  ],
}

export const dummyBeta: ModuleDefinition = {
  id: "dummy-beta",
  layer: Layer.empty,
  panels: [
    { id: "beta", title: "Beta", component: () => <Dummy name="Beta" />, defaultPlacement: "right" },
  ],
}
