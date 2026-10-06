import { type FormEvent, useState } from "react"

/** Full-page password prompt shown on the dev site while dev-only modules are present and there is no session. */
export const LockScreen = ({ login, onUnlocked }: { login: (password: string) => Promise<boolean>; onUnlocked: () => void }) => {
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setPending(true)
    setFailed(false)
    const ok = await login(password).catch(() => false)
    setPending(false)
    if (ok) onUnlocked()
    else setFailed(true)
  }

  return (
    <main className="lock">
      <form onSubmit={submit} data-testid="lock-screen" aria-labelledby="lock-title" style={{ display: "flex", flexDirection: "column", gap: 8, width: "min(320px, 90vw)" }}>
        <h1 id="lock-title" style={{ fontSize: "1.2em", margin: 0 }}>Deadlock Query (dev)</h1>
        <label htmlFor="lock-password">Password</label>
        <input id="lock-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ font: "inherit" }} />
        <button type="submit" disabled={pending || password === ""} style={{ font: "inherit" }}>{pending ? "Checking…" : "Unlock"}</button>
        {failed && <p role="alert" className="error-text" style={{ margin: 0 }}>Wrong password.</p>}
      </form>
    </main>
  )
}
