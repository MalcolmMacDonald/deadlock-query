import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import { findByWord, type DocIndex } from "../docs/catalog.ts"

export const SHOW_DOCS_COMMAND = "dlq.showDocs"
const MAX_LINKS = 4

/**
 * Appends "Docs: …" links to the hover of any identifier the library catalog knows (top-level exports
 * and members). A member name can exist on several classes (`select` on `Seq` and others), so every
 * owner is linked; the links open the docs panel on that entry.
 */
export const registerDocsHover = (monaco: typeof Monaco, index: DocIndex, modelUri: Monaco.Uri, open: (id: string) => void): Monaco.IDisposable => {
  const command = monaco.editor.registerCommand(SHOW_DOCS_COMMAND, (_accessor, id: unknown) => { if (typeof id === "string") open(id) })
  const provider = monaco.languages.registerHoverProvider("typescript", {
    provideHover: (model, position) => {
      if (model.uri.toString() !== modelUri.toString()) return null
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const hits = findByWord(index, word.word)
      if (hits.length === 0) return null
      const links = hits.slice(0, MAX_LINKS).map((i) => `[\`${i.id}\`](command:${SHOW_DOCS_COMMAND}?${encodeURIComponent(JSON.stringify([i.id]))})`)
      const more = hits.length > MAX_LINKS ? ` and ${hits.length - MAX_LINKS} more` : ""
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: `Docs: ${links.join(" · ")}${more}`, isTrusted: { enabledCommands: [SHOW_DOCS_COMMAND] } }],
      }
    },
  })
  return { dispose: () => { provider.dispose(); command.dispose() } }
}
