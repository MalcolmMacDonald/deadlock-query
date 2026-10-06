/**
 * Source text of the query Worker (spawned from a blob inside the sandbox iframe).
 * `prelude` is library runtime code evaluated before user code (S1: a tiny fixture).
 *
 * Wrapper strategy (S1 decision): the editor model is a plain *script* (no imports/exports).
 * Monaco's `getEmitOutput` yields JS, and the worker takes the **completion value** of an
 * indirect `eval`, so a trailing expression statement is the result and no AST rewrite is
 * needed. Type-check offsets are therefore exact. Top-level `await` is unsupported; a
 * returned thenable is awaited.
 *
 * M1: `{type:"load", bundle}` calls the prelude's `__dlqLoad(bundle)` (which defines `map`);
 * results are normalised to JSON-like values (`toArray()` for Seq/Vec3, plain objects otherwise).
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
let loadError;
// Makes any value structured-cloneable and JSON-like: Seq/Vec3 -> arrays via toArray(), classes -> plain objects.
const normalize = (v, depth = 0) => {
  if (v === null || v === undefined) return v === undefined ? null : v;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? v : String(v);
  if (t === "string" || t === "boolean") return v;
  if (t === "bigint") return Number(v);
  if (t === "function" || t === "symbol") return null;
  if (depth > 12) return null;
  if (typeof v.toArray === "function") return normalize(v.toArray(), depth + 1);
  if (v instanceof Map) return normalize(Array.from(v.entries()), depth + 1);
  if (v instanceof Set || ArrayBuffer.isView(v)) return normalize(Array.from(v), depth + 1);
  if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = normalize(v[k], depth + 1);
  return out;
};
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "ping") return postMessage({ type: "pong", id: m.id });
  if (m.type === "load") {
    try { if (typeof self.__dlqLoad === "function") self.__dlqLoad(m.bundle); loadError = undefined }
    catch (err) { loadError = String(err && err.message || err) }
    return;
  }
  if (m.type !== "run") return;
  const t0 = performance.now();
  try {
    if (loadError) throw new Error("map bundle failed to load: " + loadError);
    let value = (0, indirectEval)(m.js);
    if (value && typeof value.then === "function") value = await value;
    postMessage({ type: "result", runId: m.runId, value: normalize(value), ms: performance.now() - t0 });
  } catch (err) {
    postMessage({ type: "error", runId: m.runId, message: String(err && err.message || err) });
  }
};
`
