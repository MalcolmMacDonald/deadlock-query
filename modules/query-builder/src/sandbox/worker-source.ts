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
import { LIMITS, type Limits } from "./limits.ts"

/**
 * Capabilities removed from the worker global before user code runs (defence in depth: the iframe
 * sandbox + CSP are the real boundary). `postMessage` is captured by the worker first, so a query
 * cannot forge protocol messages; nested workers and channels are removed so a query cannot escape
 * the scrub in a child global.
 */
export const SCRUBBED_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "WebTransport",
  "Worker", "SharedWorker", "BroadcastChannel", "MessageChannel", "RTCPeerConnection", "Notification",
  "postMessage", "close", "FileReaderSync", "WebAssembly",
] as const

export const workerSource = (prelude = "", limits: Limits = LIMITS): string => `
"use strict";
${prelude}
const post = self.postMessage.bind(self);
const LIMITS = ${JSON.stringify(limits)};
for (const k of ${JSON.stringify(SCRUBBED_GLOBALS)}) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }) } catch {}
}
for (const k of ["storage", "locks", "serviceWorker", "sendBeacon"]) {
  try { Object.defineProperty(navigator, k, { value: undefined, writable: false, configurable: false }) } catch {}
}
// Allocation guards: one oversized request fails with a RangeError instead of exhausting the worker's heap.
const tooBig = (what, n) => new RangeError(what + " of " + n + " exceeds the sandbox limit of " + LIMITS.maxAllocBytes + " bytes");
const guardCtor = (name, unit) => {
  const C = self[name];
  if (typeof C !== "function") return;
  const P = new Proxy(C, {
    construct(t, args, nt) {
      if (typeof args[0] === "number" && args[0] * unit > LIMITS.maxAllocBytes) throw tooBig(name, args[0] * unit);
      return Reflect.construct(t, args, nt === P ? t : nt);
    },
    apply(t, th, args) { return Reflect.apply(t, th, args); }
  });
  Object.defineProperty(C.prototype, "constructor", { value: P, writable: true, configurable: true });
  try { Object.defineProperty(self, name, { value: P, writable: true, configurable: true }) } catch {}
};
for (const [n, u] of [["ArrayBuffer", 1], ["Int8Array", 1], ["Uint8Array", 1], ["Uint8ClampedArray", 1], ["Int16Array", 2], ["Uint16Array", 2],
  ["Int32Array", 4], ["Uint32Array", 4], ["Float32Array", 4], ["Float64Array", 8], ["BigInt64Array", 8], ["BigUint64Array", 8]]) guardCtor(n, u);
for (const m of ["repeat", "padStart", "padEnd"]) {
  const orig = String.prototype[m];
  Object.defineProperty(String.prototype, m, { value: function (n, ...rest) {
    const len = m === "repeat" ? String(this).length * n : n;
    if (len > LIMITS.maxAllocBytes) throw tooBig("String." + m, len);
    return orig.call(this, n, ...rest);
  }, writable: true, configurable: true });
}
// Timers a query leaves behind would keep running (and starve later runs), so they are cleared when the run settles.
const timers = new Set();
for (const [set, clear] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
  const origSet = self[set], origClear = self[clear];
  Object.defineProperty(self, set, { value: (...a) => { const id = origSet(...a); timers.add([origClear, id]); return id }, writable: true, configurable: true });
}
const clearTimers = () => { for (const [clear, id] of timers) clear(id); timers.clear() };
// A thrown value can have a hostile toString; never let reporting the error throw (the run would hang until timeout).
const describe = (err) => { try { return String(err && err.message || err) } catch { return "The query threw a value that cannot be converted to a string." } };
const indirectEval = eval;
let loadError;
// Thrown when the result is bigger than LIMITS.maxResultNodes values.
class ResultTooLarge extends Error {}
let nodes = 0;
const spend = (n) => { if ((nodes += n) > LIMITS.maxResultNodes) throw new ResultTooLarge("Result is too large (over " + LIMITS.maxResultNodes + " values). Return fewer rows or columns."); };
// Makes any value structured-cloneable and JSON-like: Seq/Vec3 -> arrays via toArray(), classes -> plain objects.
const normalize = (v, depth = 0) => {
  if (v === null || v === undefined) return v === undefined ? null : v;
  const t = typeof v;
  spend(1);
  if (t === "number") return Number.isFinite(v) ? v : String(v);
  if (t === "string") { spend(v.length >> 6); return v }
  if (t === "boolean") return v;
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
  if (m.type === "ping") return post({ type: "pong", id: m.id });
  if (m.type === "load") {
    try { if (typeof self.__dlqLoad === "function") self.__dlqLoad(m.bundle); loadError = undefined }
    catch (err) { loadError = describe(err) }
    return;
  }
  if (m.type !== "run") return;
  const t0 = performance.now();
  try {
    if (loadError) throw new Error("map bundle failed to load: " + loadError);
    nodes = 0;
    // Library >= 0.5: run under withRun so progress(f) and ctx.progress(f) reach the panel (throttled; the last 100% always goes through).
    let lastProgress = 0;
    const onProgress = (fraction, label) => {
      const now = performance.now();
      if (fraction < 1 && now - lastProgress < 50) return;
      lastProgress = now;
      post({ type: "progress", runId: m.runId, fraction, label });
    };
    let value = typeof self.withRun === "function" ? self.withRun({ onProgress }, () => (0, indirectEval)(m.js)) : (0, indirectEval)(m.js);
    if (value && typeof value.then === "function") value = await value;
    let totalRows;
    // Cut raw arrays before normalising (cheap), and the normalised form again (a Seq expands in normalize).
    if (Array.isArray(value) && value.length > LIMITS.maxRows) { totalRows = value.length; value = value.slice(0, LIMITS.maxRows) }
    let out = normalize(value);
    if (Array.isArray(out) && out.length > LIMITS.maxRows) { totalRows ??= out.length; out = out.slice(0, LIMITS.maxRows) }
    clearTimers();
    // Map-wide flag: placeholder semantics are loaded, so anything that used them is provisional. Only a hint, so a query that redefines map just loses the banner.
    let provisional = false;
    try { provisional = self.map != null && self.map.provisional === true } catch {}
    post({ type: "result", runId: m.runId, value: out, ms: performance.now() - t0, totalRows, provisional });
  } catch (err) {
    clearTimers();
    // A QueryCancelled (an AbortError carrying a reason) thrown by the query's own withRun is a cancellation, not a failure.
    const cancelled = err && err.name === "AbortError" && (err.reason === "timeout" || err.reason === "cancelled") ? err.reason : undefined;
    post({ type: "error", runId: m.runId, message: describe(err), cancelled });
  }
};
`
