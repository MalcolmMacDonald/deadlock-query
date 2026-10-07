import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { prefetchEditor } from "./editor.tsx"
import { whenIdle } from "./idle.ts"
import { installGlobalErrorToasts } from "./errors.ts"
import { applyTheme, loadTheme } from "./theme.ts"
import "./theme.css"

applyTheme(document, loadTheme(localStorage))
installGlobalErrorToasts()
createRoot(document.getElementById("root")!).render(<App />)
whenIdle(prefetchEditor)
