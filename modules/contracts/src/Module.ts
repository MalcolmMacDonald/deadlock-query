import type { Layer } from "effect"

export interface PanelDefinition {
  readonly id: string
  readonly title: string
  /** Framework-agnostic component handle; shell decides how to mount it. */
  readonly component: unknown
  readonly defaultPlacement: "left" | "right" | "top" | "bottom" | "center" | "float"
  readonly minSize?: { readonly width: number; readonly height: number }
}

export interface CommandDefinition {
  readonly id: string
  readonly title: string
  readonly run: () => void | Promise<void>
}

export interface ModuleDefinition<Requirements = never> {
  readonly id: string
  readonly layer: Layer.Layer<never, never, Requirements>
  readonly panels: ReadonlyArray<PanelDefinition>
  readonly commands?: ReadonlyArray<CommandDefinition>
}
