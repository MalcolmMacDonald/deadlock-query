import { useEffect, useState } from "react"
import { Effect, type Layer } from "effect"
import { feedbackBody, tokenTotal } from "./feedback.ts"
import { GitHubApi, type CiState, type Comment, type Issue } from "./github.ts"

type Api = Layer.Layer<GitHubApi>
const run = <A,>(layer: Api, f: (api: GitHubApi["Service"]) => Effect.Effect<A, Error>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* f(yield* GitHubApi) }).pipe(Effect.provide(layer)))

export const DrawerView = ({ issue, comments, onSend }: { issue: Issue; comments: ReadonlyArray<Comment>; onSend: (text: string) => void }) => {
  const [text, setText] = useState("")
  const body = feedbackBody(text)
  return (
    <aside aria-label={`Feedback for #${issue.number}`}>
      <h3>#{issue.number} {issue.title}</h3>
      {issue.pr ? <p>PR #{issue.pr.number} · CI {issue.pr.ci}</p> : null}
      <p>Tokens used: {tokenTotal(comments).toLocaleString("en-US")}</p>
      <ul>{comments.map((c) => <li key={c.id}><b>{c.author}</b> {c.body}</li>)}</ul>
      <textarea aria-label="Feedback" value={text} onChange={(e) => setText(e.target.value)} />
      <button disabled={!body} onClick={() => { if (body) { onSend(body); setText("") } }}>Send to Claude</button>
    </aside>
  )
}

export const Drawer = ({ layer, issue }: { layer: Api; issue: Issue }) => {
  const [comments, setComments] = useState<ReadonlyArray<Comment>>([])
  const [error, setError] = useState<string>()
  useEffect(() => { run(layer, (api) => api.comments(issue.number)).then(setComments, (e: Error) => setError(e.message)) }, [layer, issue.number])
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      <DrawerView issue={issue} comments={comments} onSend={(t) => void run(layer, (api) => api.addComment(issue.number, t)).then((c) => setComments((cs) => [...cs, c]), (e: Error) => setError(e.message))} />
    </>
  )
}

export const HeaderView = ({ ci, onPromote, promoted }: { ci: CiState | undefined; onPromote: () => void; promoted: boolean }) => (
  <header>
    <span>main CI: {ci ?? "unknown"}</span>
    <button disabled={ci !== "success" || promoted} onClick={onPromote}>{promoted ? "Promote requested" : "Promote to prod"}</button>
  </header>
)

export const Header = ({ layer }: { layer: Api }) => {
  const [ci, setCi] = useState<CiState>()
  const [promoted, setPromoted] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { run(layer, (api) => api.mainCi).then(setCi, (e: Error) => setError(e.message)) }, [layer])
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      <HeaderView ci={ci} promoted={promoted} onPromote={() => void run(layer, (api) => api.promote).then(() => setPromoted(true), (e: Error) => setError(e.message))} />
    </>
  )
}
