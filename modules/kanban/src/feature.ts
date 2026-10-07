import type { IssueDraft } from "./github.ts"

export interface FeatureForm {
  readonly module: string
  readonly title: string
  readonly description: string
  readonly acceptance: string
}

export type FeatureResult = { readonly ok: true; readonly draft: IssueDraft } | { readonly ok: false; readonly errors: ReadonlyArray<string> }

/** Validates the form and builds the issue; the result always has exactly one `module:<id>` label. */
export const buildFeatureIssue = (form: FeatureForm, modules: ReadonlyArray<string>): FeatureResult => {
  const errors: string[] = []
  if (!modules.includes(form.module)) errors.push("Choose a module")
  if (form.title.trim() === "") errors.push("Title is required")
  if (errors.length > 0) return { ok: false, errors }
  const body = [`## Description\n${form.description.trim()}`, `## Acceptance criteria\n${form.acceptance.trim()}`].join("\n\n")
  return { ok: true, draft: { title: form.title.trim(), body, labels: [`module:${form.module}`] } }
}
