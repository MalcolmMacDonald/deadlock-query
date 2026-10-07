import { useState } from "react"
import { buildFeatureIssue } from "./feature.ts"
import type { IssueDraft } from "./github.ts"

export const FeatureFormView = ({ modules, onCreate }: { modules: ReadonlyArray<string>; onCreate: (draft: IssueDraft) => void }) => {
  const [form, setForm] = useState({ module: "", title: "", description: "", acceptance: "" })
  const [errors, setErrors] = useState<ReadonlyArray<string>>([])
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) })
  return (
    <form aria-label="New feature" onSubmit={(e) => {
      e.preventDefault()
      const r = buildFeatureIssue(form, modules)
      setErrors(r.ok ? [] : r.errors)
      if (r.ok) { onCreate(r.draft); setForm({ ...form, title: "", description: "", acceptance: "" }) }
    }}>
      <label>Module <select {...field("module")}><option value="">—</option>{modules.map((m) => <option key={m}>{m}</option>)}</select></label>
      <label>Title <input {...field("title")} /></label>
      <label>Description <textarea {...field("description")} /></label>
      <label>Acceptance criteria <textarea {...field("acceptance")} /></label>
      {errors.length > 0 ? <ul role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <button type="submit">Create feature</button>
    </form>
  )
}
