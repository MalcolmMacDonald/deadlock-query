// Vite-only (`?worker&url`): kept out of the modules graph so Bun unit tests can import `modules.ts`.
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url"
import tsWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker?worker&url"

/** Where Monaco's workers are served: bundled by Vite into the site's assets. */
export const monacoWorkerUrl = (label: string): string =>
  label === "typescript" || label === "javascript" ? tsWorkerUrl : editorWorkerUrl
