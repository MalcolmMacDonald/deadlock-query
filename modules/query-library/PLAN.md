# query-library — plan

## 1. Purpose & scope
The typed **TypeScript query API** users write against, "in the style of LINQ": a `map` object exposing entities and spatial functions, plus fluent helpers. It ships as (a) runtime JS executed in the query worker, (b) generated `.d.ts` feeding Monaco's suggestions, and (c) an API catalog for the docs panel.

**Non-goals:** no editor/UI (query-builder), no sandboxing (query-builder), no extraction/baking (extractor), no low-level algorithms (spatial-core).

## 2. Ownership boundary
`modules/query-library/**` → `@deadlock-query/query-library`. Build outputs in `dist/`: `index.js` (ESM, worker-safe), `index.d.ts` (+ per-file `.d.ts`), `apiCatalog.json`, `package.json` with `apiVersion`.

## 3. Published surface

**Entry** (available as globals in every query): `map: MapContext`, `seconds(n)`, `meters(n)`, `units(n)`, `Lane` string-literal union, helper constructors (`vec(x,y,z)`), `progress(f)`, `ctx` (settings, cancellation).

```ts
map.guardians | walkers | patrons | healingOrbs | creepCamps | sinnersSacrifices | ziplines | walls  // typed arrays of entities
map.sample.grid(spacing, {region?})        // Vec3 sample points on walkable floors
map.sample.walls(spacing)                  // points along wall bases
map.nav                                    // NavApi: distance/path/distanceField
```
Entities and `Vec3` are classes with methods so suggestions appear after the dot:
```ts
v.distanceTo(o)  v.nearestWall()  v.isInterior()  v.height()  v.visibleFrom(p | iterable, opts)  v.travelTimeTo(o)  v.travelDistanceTo(o)  v.crowFliesTo(o)
entities.inLane("yellow")  entities.within(range, of)  entities.withinTravelTime(seconds(10), of)  entities.visibleFrom(viewpoints)  entities.highGround(minHeight)
```
LINQ-style helpers over iterables (`Seq<T>` lazy; native array methods also work): `where select selectMany groupBy orderBy thenBy distinct take skip first any all count sum min max zip pairs() chunk toArray`.

Example queries (also shipped as `examples/*.ts` with `@example` tags):
```ts
map.healingOrbs.withinTravelTime(seconds(10), map.guardians.inLane("yellow"))
map.sample.walls(200).pairs().where(([a, b]) => a.travelDistanceTo(b) > 2 * a.crowFliesTo(b))
map.creepCamps.visibleFrom(map.sample.grid(300).filter(p => p.height() > 800))
```
Return values: any iterable/array of entities, `Vec3`s, segments/pairs (rendered as lines), polygons, plain records/tuples. The builder projects them into `QueryResult`.

## 4. Uses
`contracts` (entity/bundle types, `QueryResult` geometry types), `spatial-core` (BVH, grid, navmesh, visibility). Data arrives through `MapContext.fromBundle(loaded)` where `loaded` is the transferable ArrayBuffers + parsed manifest/entities provided by the builder's worker.

## 5. Technical design
- **Typed DX is the product**: every public symbol has TSDoc with summary, parameters, `@example`, complexity note, and `@category`. String-literal unions (`Lane`, entity `kind`s) so completion lists values. Overloads kept few and readable. Method names read well in a one-liner.
- **Lazy by default**: `Seq` pipelines avoid materialising big cross products (`pairs()` is a generator); heavy functions memoise (distance fields cached per source-set key; BVH built/loaded once).
- **Parallelism-ready**: functions accept `ctx.signal` cancellation and `ctx.progress`; `ctx.parallel` (Phase 3) will shard index ranges across a worker pool.
- **Entities + overrides**: `MapContext` merges extractor entities with accepted metadata (camps, sacrifices, nav overrides/links) with provenance fields.
- **Owner-authored semantics (D15)**: `isInterior`, `isVisible`, `nearestWall` (and later similar predicates) are **not implemented here**. They live in `spatial-core/src/semantics/` and are written by the project owner on top of the `Raycaster` (three-mesh-bvh). This module only wraps them as fluent methods (`v.isInterior()`, `v.visibleFrom(...)`, `v.nearestWall()`), forwards `ctx.settings` as `SemanticsParams`, keeps their TSDoc in the catalog (docs text provided by the owner in `semantics/*.ts` JSDoc), and surfaces the `PLACEHOLDER_SEMANTICS` flag so results can be marked provisional. Never edit `semantics/` bodies from this module; request signature changes via `STATE.md`.
- **Semantics doc** `docs/semantics.md` covers only what this module owns: units (Source units; `seconds()` uses `ctx.settings.heroSpeed`), travel-time model (navmesh + links + speed), settings knobs and defaults — these defaults are proposals for the owner to confirm.
- **Build**: `tsc --emitDeclarationOnly` for `.d.ts`, bundled runtime with esbuild/Bun (no Node APIs), catalog generator reads TSDoc (ts-morph/typedoc JSON) → `apiCatalog.json` (name, signature, summary, category, examples, since). Tests assert every public export has docs + an example.
- **Versioning (D7)**: `apiVersion` = package version; breaking API changes require a major bump (checked by an API-snapshot test using api-extractor report diff). Deprecated members stay one major with `@deprecated` (shown struck-through by Monaco).

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Scaffold, build pipeline emitting `index.js`, `index.d.ts`, catalog; docs lint | `dist/` produced; builder agent can load `.d.ts` in Monaco |
| M1 | **Slice 1**: entity collections from fixture/real bundle, `Vec3` with `distanceTo`, `inLane`, `within`, `Seq` helpers, units; the Slice-1 query runs | Slice-1 query returns `expected/slice1.json` on fixture and plausible rows on real bundle |
| M2 | API snapshot test, TSDoc coverage gate, example files, catalog | CI fails on undocumented export or undeclared API break |
| M3 | Fluent wrappers over spatial-core: `nearestWall`, `isInterior`, `height`, `visibleFrom`, `sample.*` (work with placeholder *or* owner semantics; provisional flag propagated) | Wrapper tests with a stub `Raycaster`; fixture tests assert only wiring + determinism, not semantic correctness |
| M4 | Navigation: `travelTime/Distance`, `withinTravelTime`, `pairs()`, distance-field caching | Headline queries 1 & 2 match golden results; query 2 completes on real map < 30 s (target) |
| M5 | Headline query 3 + more helpers (`closest`, `groupBy region`, heat/density) | Golden tests |
| M6 | Metadata merge (camps/sacrifices/nav overrides) with provenance | Fixture with overrides changes results as expected |
| M7 | Perf pass, cancellation/progress everywhere, `ctx.parallel` design | Budgets in `STATE.md` |

## 7. Test strategy
Vitest/bun test golden tests on contracts fixtures; type tests (`tsd`/`expectTypeOf`) to lock the suggestion-relevant types; API snapshot; benchmark suite for heavy functions.

## 8. Standalone mode
`bun run repl` evaluates a query file against a bundle directory in Node/Bun with the same library (fast iteration without the browser).

## 9. Risks & open questions
- Interior/visibility semantics are owner-authored (schedule dependency; placeholders until then); the travel-time model must be confirmed with the owner.
- API ergonomics for one-liners drive adoption; plan a short usability review of the first 10 queries.
- Pair queries are O(n²): need sampling guidance in docs and cancellation.

## 10. Definition of done
Documented, typed API covering all three headline queries with golden tests; catalog and `.d.ts` consumed by builder; API snapshot gate in CI; owner semantics in place (no `PLACEHOLDER_SEMANTICS`), travel-time model documented and confirmed.
