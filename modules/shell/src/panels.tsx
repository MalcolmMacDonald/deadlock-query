import type { IDockviewPanelProps } from "dockview"
import { Component, type ComponentType, type FunctionComponent, type ReactNode, useEffect, useRef } from "react"
import type { PanelDefinition } from "@deadlock-query/contracts"
import { notify } from "./toasts.ts"

/** Framework-agnostic panel handle (e.g. map-viewer's `viewer.main`): mount into a container, return dispose. */
export interface MountHandle {
  readonly mount: (container: HTMLElement) => () => void
}

const isMountHandle = (c: unknown): c is MountHandle =>
  typeof c === "object" && c !== null && typeof (c as MountHandle).mount === "function"

export const ErrorPanel = ({ moduleId, message }: { moduleId: string; message: string }) => (
  <div role="alert" data-testid={`error-panel-${moduleId}`} className="error-text" style={{ padding: 12 }}>
    <h3>Module “{moduleId}” failed</h3>
    <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
  </div>
)

class Boundary extends Component<{ moduleId: string; children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    notify("error", `Panel from module “${this.props.moduleId}” crashed: ${error.message}`)
  }
  render() {
    const { error } = this.state
    return error ? <ErrorPanel moduleId={this.props.moduleId} message={error.message} /> : this.props.children
  }
}

const MountHost = ({ handle }: { handle: MountHandle }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dispose = handle.mount(ref.current!)
    return () => dispose()
  }, [handle])
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />
}

/** Wraps a panel (React component or mount handle) in an error boundary so a throwing panel only breaks itself. */
export const toDockviewComponent = (moduleId: string, panel: PanelDefinition): FunctionComponent<IDockviewPanelProps> => {
  const c = panel.component
  const Inner = isMountHandle(c) ? () => <MountHost handle={c} /> : (c as ComponentType<IDockviewPanelProps>)
  return (props) => (
    <Boundary moduleId={moduleId}>
      <Inner {...props} />
    </Boundary>
  )
}
