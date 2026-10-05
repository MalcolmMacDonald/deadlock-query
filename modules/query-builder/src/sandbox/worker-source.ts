/**
 * Source text of the query Worker (spawned from a blob inside the sandbox iframe).
 * `prelude` is library runtime code evaluated before user code (S1: a tiny fixture).
 *
 * Wrapper strategy (S1 decision): the editor model is a plain *script* (no imports/exports).
 * Monaco's `getEmitOutput` yields JS, and the worker takes the **completion value** of an
 * indirect `eval`, so a trailing expression statement is the result and no AST rewrite is
 * needed. Type-check offsets are therefore exact. Top-level `await` is unsupported; a
 * returned thenable is awaited.
 */
export const SCRUBBED_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "WebTransport",
] as const

export const workerSource = (prelude = ""): string => `
"use strict";
${prelude}
for (const k of ${JSON.stringify(SCRUBBED_GLOBALS)}) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }) } catch {}
}
const indirectEval = eval;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "ping") return postMessage({ type: "pong", id: m.id });
  if (m.type !== "run") return;
  const t0 = performance.now();
  try {
    let value = (0, indirectEval)(m.js);
    if (value && typeof value.then === "function") value = await value;
    postMessage({ type: "result", runId: m.runId, value, ms: performance.now() - t0 });
  } catch (err) {
    postMessage({ type: "error", runId: m.runId, message: String(err && err.message || err) });
  }
};
`
