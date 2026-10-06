import { useEffect, useId, useMemo, useRef, useState } from "react"
import { filterCommands, type PaletteCommand } from "./commands.ts"
import { notify } from "./toasts.ts"

/** Modal command palette (Ctrl/Cmd+K): type to filter, arrows to move, Enter to run, Escape to close. */
export const CommandPalette = ({ commands, onClose }: { commands: ReadonlyArray<PaletteCommand>; onClose: () => void }) => {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const matches = useMemo(() => filterCommands(commands, query), [commands, query])
  const current = Math.min(active, matches.length - 1)

  // Return focus to wherever it was when the palette opened.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => previous?.focus?.()
  }, [])

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return
    onClose()
    void Promise.resolve(c.run()).catch((e) => notify("error", `“${c.title}” failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose() }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(matches.length ? (current + 1) % matches.length : 0) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(matches.length ? (current - 1 + matches.length) % matches.length : 0) }
    else if (e.key === "Enter") { e.preventDefault(); run(matches[current]) }
    else if (e.key === "Tab") e.preventDefault() // focus stays in the palette while it is open
  }

  return (
    <div
      data-testid="command-palette-backdrop"
      className="palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches[current] ? `${listId}-${current}` : undefined}
          aria-label="Type a command"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
        />
        <ul id={listId} role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              data-command={c.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span>{c.title}</span>
              <span className="meta">{c.shortcut ? `${c.shortcut} · ${c.group}` : c.group}</span>
            </li>
          ))}
          {matches.length === 0 && <li className="empty" role="presentation">No matching commands</li>}
        </ul>
      </div>
    </div>
  )
}
