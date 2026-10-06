import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { execSync } from "node:child_process"

/** Short git SHA for the About panel: CI's `GITHUB_SHA`, else the checkout's HEAD, else "unknown". */
const gitSha = (): string => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown"
  } catch {
    return "unknown"
  }
}

// Prod is served under /deadlock-query/, dev at /; infra passes the base via env.
export default defineConfig({
  base: process.env.SHELL_BASE ?? "./",
  plugins: [react()],
  define: { __BUILD_INFO__: JSON.stringify({ gitSha: gitSha(), builtAt: new Date().toISOString() }) },
  // Monaco workers are ES modules (Monaco starts them with `type: "module"`).
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
})
