import { workerSource } from "./worker-source.ts"

/** CSP for the sandbox document; workers created from blob: inherit it. */
export const sandboxCsp = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'`

/**
 * HTML for the `<iframe sandbox="allow-scripts" srcdoc=...>` (opaque origin).
 * Protocol with the parent (postMessage, only accepted from `parent`):
 *   parent→frame: {type:"run",runId,js} | {type:"cancel",runId}
 *   frame→parent: {type:"ready"} | {type:"result"|"error",runId,...} | {type:"cancelled",runId}
 * Cancel = `worker.terminate()` + respawn; `ready` is re-sent once the new worker answers a ping.
 */
export const frameHtml = (nonce: string, prelude = ""): string => `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${sandboxCsp(nonce)}">
</head><body><script nonce="${nonce}">
const SRC = ${JSON.stringify(workerSource(prelude))};
let worker;
const spawn = () => {
  worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: "text/javascript" })));
  worker.onmessage = (e) => e.data.type === "pong" ? parent.postMessage({ type: "ready" }, "*") : parent.postMessage(e.data, "*");
  worker.postMessage({ type: "ping", id: 0 });
};
spawn();
onmessage = (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "run") worker.postMessage(m);
  else if (m.type === "cancel") { worker.terminate(); parent.postMessage({ type: "cancelled", runId: m.runId }, "*"); spawn(); }
};
</script></body></html>`
