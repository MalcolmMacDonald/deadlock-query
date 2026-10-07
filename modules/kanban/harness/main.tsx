import { createRoot } from "react-dom/client"
import { Layer } from "effect"
import { MockDevAuth } from "@deadlock-query/contracts"
import { Board, MockGitHubApi } from "../src/index.ts"

const layer = Layer.mergeAll(MockGitHubApi(), MockDevAuth)
createRoot(document.getElementById("root")!).render(<Board layer={layer} module="map-metadata" />)
