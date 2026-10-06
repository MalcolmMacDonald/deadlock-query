import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"

document.body.style.cssText = "margin:0;background:#111;color:#ddd;font-family:system-ui,sans-serif"
createRoot(document.getElementById("root")!).render(<App />)
