import { useEffect, useState } from "react"
import { Effect, type Layer } from "effect"
import { DevAuth } from "@deadlock-query/contracts"
import { COLUMNS, groupByColumn } from "./board.ts"
import { GitHubApi, type Issue } from "./github.ts"
import { loadPrefs, moveLane, orderLanes, savePrefs, toggleCollapsed, type PrefsStore } from "./lanes.ts"

export const BoardView = ({ issues, module, collapsed = false, onToggle, onMove }: {
  issues: ReadonlyArray<Issue>
  module: string
  collapsed?: boolean
  onToggle?: () => void
  onMove?: (delta: -1 | 1) => void
}) => {
  const g = groupByColumn(issues, module)
  return (
    <section aria-label={`${module} lane`}>
      <h2>
        <button aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "▸" : "▾"} {module}</button>
        <button aria-label={`move ${module} up`} onClick={() => onMove?.(-1)}>↑</button>
        <button aria-label={`move ${module} down`} onClick={() => onMove?.(1)}>↓</button>
      </h2>
      {collapsed ? null : <div style={{ display: "flex", gap: 8 }}>
        {COLUMNS.map((c) => (
          <div key={c} role="group" aria-label={c} style={{ flex: 1 }}>
            <h3>{c}</h3>
            {g[c].map((i) => (
              <article key={i.number}>
                #{i.number} {i.title}
                {i.pr ? <small> · PR #{i.pr.number} CI {i.pr.ci}</small> : null}
              </article>
            ))}
          </div>
        ))}
      </div>}
    </section>
  )
}

/** `kanban.board`: lock screen without a session, otherwise one collapsible, reorderable lane per module. */
export const Board = ({ layer, modules, store }: { layer: Layer.Layer<GitHubApi | DevAuth>; modules: ReadonlyArray<string>; store: PrefsStore }) => {
  const [prefs, setPrefs] = useState(() => loadPrefs(store))
  const update = (next: typeof prefs) => { setPrefs(next); savePrefs(store, next) }
  const [state, setState] = useState<{ auth: "anonymous" | "authenticated" | "loading"; issues: ReadonlyArray<Issue>; error?: string }>({ auth: "loading", issues: [] })
  useEffect(() => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* (yield* DevAuth).status
        if (auth === "anonymous") return { auth, issues: [] as ReadonlyArray<Issue> }
        return { auth, issues: yield* (yield* GitHubApi).listIssues }
      }).pipe(Effect.provide(layer), Effect.catch((e: Error) => Effect.succeed({ auth: "authenticated" as const, issues: [] as ReadonlyArray<Issue>, error: e.message })))
    ).then(setState)
  }, [layer])
  if (state.auth === "loading") return <p>Loading…</p>
  if (state.auth === "anonymous") return <p role="alert">Locked: sign in to the dev site to use the kanban.</p>
  return state.error ? <p role="alert">{state.error}</p> : <>{orderLanes(modules, prefs).map((m) => (
    <BoardView key={m} issues={state.issues} module={m} collapsed={prefs.collapsed.includes(m)}
      onToggle={() => update(toggleCollapsed(prefs, m))} onMove={(d) => update(moveLane(modules, prefs, m, d))} />
  ))}</>
}
