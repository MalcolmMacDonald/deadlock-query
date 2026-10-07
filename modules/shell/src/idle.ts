type IdleHost = {
  readonly requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown
  readonly setTimeout: (cb: () => void, ms: number) => unknown
}

/** Runs `task` once the browser is idle (falls back to a short timer), so heavy prefetches never compete with first paint. */
export const whenIdle = (task: () => void, host: IdleHost = globalThis as unknown as IdleHost): void => {
  if (host.requestIdleCallback) host.requestIdleCallback(task, { timeout: 5000 })
  else host.setTimeout(task, 1500)
}
