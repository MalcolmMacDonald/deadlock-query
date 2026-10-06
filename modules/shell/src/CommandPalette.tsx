import { useEffect, useId, useMemo, useRef, useState } from "react"
import { filterCommands, type PaletteCommand } from "./commands.ts"

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
    void Promise.resolve(c.run()).catch((e) => console.error(`command ${c.id} failed:`, e))
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
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "15vh" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onKeyDown={onKeyDown}
        style={{ width: "min(560px, 90vw)", background: "#1e1e1e", border: "1px solid #444", borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}
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
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", background: "transparent", color: "inherit", border: 0, borderBottom: "1px solid #444", outline: "none", font: "inherit" }}
        />
        <ul id={listId} role="listbox" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "50vh", overflowY: "auto" }}>
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              data-command={c.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
              style={{ padding: "6px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", background: i === current ? "#094771" : "transparent" }}
            >
              <span>{c.title}</span>
              <span style={{ opacity: 0.5, fontSize: "0.85em" }}>{c.group}</span>
            </li>
          ))}
          {matches.length === 0 && <li style={{ padding: "6px 12px", opacity: 0.6 }}>No matching commands</li>}
        </ul>
      </div>
    </div>
  )
}
