import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import { SNIPPETS, expandSnippet } from "../docs/snippets.ts"

/**
 * Registers the query snippets as completion items on the query model only. Statement snippets are
 * offered where a new expression can start; chain snippets only right after a `.`, where they take
 * the dot over (their body starts with it).
 */
export const registerSnippetCompletions = (monaco: typeof Monaco, modelUri: Monaco.Uri): Monaco.IDisposable =>
  monaco.languages.registerCompletionItemProvider("typescript", {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position) => {
      if (model.uri.toString() !== modelUri.toString()) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const afterDot = word.startColumn > 1 && model.getValueInRange(new monaco.Range(position.lineNumber, word.startColumn - 1, position.lineNumber, word.startColumn)) === "."
      return {
        suggestions: SNIPPETS.filter((s) => (s.kind === "chain") === afterDot).map((s) => ({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: "```ts\n" + expandSnippet(s.body) + "\n```" },
          range: new monaco.Range(position.lineNumber, afterDot ? word.startColumn - 1 : word.startColumn, position.lineNumber, word.endColumn),
          filterText: afterDot ? `.${s.label}` : s.label,
          // Library members (sorted by label) should win over snippets for the same prefix.
          sortText: `z_${s.label}`,
        })),
      }
    },
  })
