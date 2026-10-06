import { workerSource } from "./worker-source.ts"

/** JSON for embedding inside an inline `<script>`: `<` is escaped so the payload cannot close the tag. */
const safeJson = (v: unknown): string => JSON.stringify(v).replaceAll("<", "\\u003c")

/** CSP for the sandbox document; workers created from blob: inherit it. */
export const sandboxCsp = (nonce: string): string =>
  // `blob:` is only allowed for creating the worker, not for scripts/modules, so `import(blobUrl)` is blocked.
  `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`

/**
 * HTML for the `<iframe sandbox="allow-scripts" srcdoc=...>` (opaque origin).
 * Protocol with the parent (postMessage, only accepted from `parent`):
 *   parent→frame: {type:"run",runId,js} | {type:"load",bundle} | {type:"cancel",runId}
 *   frame→parent: {type:"ready"} | {type:"result"|"error",runId,...} | {type:"cancelled",runId}
 * `load` is remembered and replayed to every respawned worker (before the ping, so `ready` implies loaded).
 * Cancel = `worker.terminate()` + respawn; `ready` is re-sent once the new worker answers a ping.
 */
export const frameHtml = (nonce: string, prelude = ""): string => `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${sandboxCsp(nonce)}">
</head><body><script nonce="${nonce}">
const SRC = ${safeJson(workerSource(prelude))};
let worker, loadMsg;
const spawn = () => {
  worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: "text/javascript" })));
  worker.onmessage = (e) => e.data.type === "pong" ? parent.postMessage({ type: "ready" }, "*") : parent.postMessage(e.data, "*");
  if (loadMsg) worker.postMessage(loadMsg);
  worker.postMessage({ type: "ping", id: 0 });
};
spawn();
onmessage = (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "run") worker.postMessage(m);
  else if (m.type === "load") { loadMsg = m; worker.postMessage(m); worker.postMessage({ type: "ping", id: 0 }); }
  else if (m.type === "cancel") { worker.terminate(); parent.postMessage({ type: "cancelled", runId: m.runId }, "*"); spawn(); }
};
</script></body></html>`
