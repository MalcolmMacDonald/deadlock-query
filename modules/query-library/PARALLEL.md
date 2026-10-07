# `ctx.parallel` design (Phase 3, not implemented)

Goal: let a query shard an index range over a pool of workers that each hold the same map (bundle bytes are shared; the
collision BVH, navmesh and sample grid are zero-copy `SharedArrayBuffer`s, see spatial-core's serialisation).

## Shape

```ts
const hits = await ctx.parallel.map(map.sample.grid(100).toArray(), (p) => p.visibleFrom(...), { chunk: 512 })
```

- `ctx.parallel.map(items, fn, opts)` and `ctx.parallel.reduce(items, fn, combine, init, opts)`; results keep input order.
- `fn` must be a pure function of its item and the loaded map: it is serialised with `fn.toString()` and re-evaluated in
  each worker, so it cannot close over local variables. Constants go through `opts.args` (structured-cloned, read-only).
  The query-builder rejects closures it can detect (free variables) before dispatching.
- Items are `Vec3`/entity ids/plain numbers (structured-clone friendly). Entities are passed as ids and resolved in the worker.
- Determinism: chunks are fixed-size slices by input index, merged in index order, so the output equals the sequential run.
- A query that uses `ctx.parallel` becomes async at that call only; everything else stays synchronous.

## Cancellation, budget, progress

- The pool shares one `Int32Array` cancel flag (SAB). `RunOptions.shouldCancel` in each worker reads it; the main thread
  sets it on abort or when `maxMillis` expires. Workers throw `QueryCancelled` at their next check; the pool rejects.
- Each finished chunk reports `chunks done / total` through `progress` of the parent run.

## Costs and limits

- Navmesh distance fields are per-worker caches (0.7 MB each on the real map); sharding by source keeps a field in one worker.
- Break-even: a task should cost at least ~5 ms per chunk (worker round trip); below that stay sequential. `ctx.parallel`
  falls back to sequential when `navigator.hardwareConcurrency` is 1 or the item count is under one chunk.
- Prerequisites: query-builder owns the worker pool; spatial-core needs `Raycaster`/`NavMesh` constructors from shared
  buffers (the serialised forms already are zero-copy). No library change is needed until those exist.
