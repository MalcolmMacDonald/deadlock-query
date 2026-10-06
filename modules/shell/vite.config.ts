import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Prod is served under /deadlock-query/, dev at /; infra passes the base via env.
export default defineConfig({
  base: process.env.SHELL_BASE ?? "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
})
