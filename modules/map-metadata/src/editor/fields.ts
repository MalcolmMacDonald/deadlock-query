import { Effect, Schema } from "effect"
import type { MetadataKind, MetadataRecord } from "@deadlock-query/contracts"
import { kindDefinition } from "../kinds.ts"

export type FieldSpec =
  | { readonly key: string; readonly label: string; readonly type: "text"; readonly max: number }
  | { readonly key: string; readonly label: string; readonly type: "number"; readonly optional: boolean; readonly min?: number; readonly step?: number }
  | { readonly key: string; readonly label: string; readonly type: "select"; readonly options: ReadonlyArray<string>; readonly optional: boolean }
  | { readonly key: string; readonly label: string; readonly type: "bool" }

const common: ReadonlyArray<FieldSpec> = [
  { key: "name", label: "Name", type: "text", max: 120 },
  { key: "note", label: "Note", type: "text", max: 1000 }
]

/** The editable fields per kind (beyond geometry, which is drawn): the per-kind forms in the panel. */
const KIND_FIELDS: { readonly [K in MetadataKind]: ReadonlyArray<FieldSpec> } = {
  walkableRegion: [
    { key: "flag", label: "Flag", type: "select", options: ["walkable", "noGo", "interior", "water"], optional: false },
    { key: "floorZ", label: "Floor height", type: "number", optional: false, step: 1 },
    { key: "costMultiplier", label: "Path cost multiplier", type: "number", optional: true, min: 0.01, step: 0.1 }
  ],
  creepCamp: [{ key: "tier", label: "Tier", type: "select", options: ["weak", "medium", "strong"], optional: true }],
  sinnersSacrifice: [],
  healingOrb: [{ key: "respawnSeconds", label: "Respawn (seconds)", type: "number", optional: true, min: 0.1, step: 1 }],
  navLink: [
    { key: "linkKind", label: "Link type", type: "select", options: ["zipline", "jumpPad", "climb", "teleport", "custom"], optional: false },
    { key: "bidirectional", label: "Both directions", type: "bool" },
    { key: "cost", label: "Cost", type: "number", optional: true, min: 0.01, step: 1 }
  ],
  custom: [{ key: "label", label: "Label", type: "text", max: 60 }]
}

export const fieldsFor = (kind: MetadataKind): ReadonlyArray<FieldSpec> => [...common, ...KIND_FIELDS[kind]]

/**
 * Apply `patch` to a record and re-check it against the kind's schema. An `undefined` value removes an optional key
 * (a cleared form field). Returns the new record or the reason it was refused; the input is never modified.
 */
export const applyPatch = (record: MetadataRecord, patch: Readonly<Record<string, unknown>>): { readonly record: MetadataRecord } | { readonly error: string } => {
  const next: Record<string, unknown> = { ...record }
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "kind" || k === "status" || k === "provenance") return { error: `"${k}" cannot be edited` }
    if (v === undefined || v === "") delete next[k]
    else next[k] = v
  }
  const r = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(kindDefinition(record.kind).schema)(next)))
  return r._tag === "Success" ? { record: r.success } : { error: String(r.failure.message ?? r.failure) }
}
