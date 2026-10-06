import { Effect, Layer } from "effect"
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

/** Demonstrates per-module isolation: its Layer dies, so its panel renders as an error panel. */
export const dummyBroken: ModuleDefinition = {
  id: "dummy-broken",
  layer: Layer.effectDiscard(Effect.die(new Error("dummy-broken failed to start"))),
  panels: [
    { id: "broken", title: "Broken", component: () => <Dummy name="Broken" />, defaultPlacement: "center" },
  ],
}

/** A dev-only module, for demoing and testing the lock screen. */
export const dummyDevOnly: ModuleDefinition = {
  id: "dummy-dev-only",
  layer: Layer.empty,
  panels: [
    { id: "devonly", title: "Dev tool", component: () => <Dummy name="Dev tool" />, defaultPlacement: "bottom" },
  ],
}
