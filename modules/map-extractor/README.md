# map-extractor

Local-only CLI that turns a Deadlock install into a map bundle (render tiles, collision, entities) and the baked spatial data the query modules read. It runs on the machine that has the game; everything else only consumes the bundle.

```
bun run dlq-extract <command> [--json]
```

| Command | What it does |
| --- | --- |
| `doctor` | checks the Deadlock install, the build id and the pinned Source2Viewer CLI |
| `list-maps` | maps in the game paks |
| `extract --map dl_midtown --tier lite` | exports render, collision, nav and entities into `data/bundles/<build>/`; every stage is cached in `.work`, so a rerun with nothing changed only reads the cache |
| `tile <bundle>` | lite tier: meshopt-compress the tiles, add the `#lod1` / `#lod2` LOD tiles (`Tile.lod` / `lodOf` in the manifest) |
| `bake <bundle>` | collision BVH, sample grid (floor, interior, wall distance) and navmesh, written to `baked/` and recorded in the manifest; `--force` redoes it |
| `pack-lite <bundle>` | checks the lite bundle against the size budget and for stray textures |
| `inspect <bundle>` | validates the manifest and entities against the contracts and sanity-checks the frame |
| `diff <a> <b>` | lists what changed between two bundles (build, tiles, entities by kind and team, bake and navmesh numbers); exit 1 when they differ |

From the repo root, `bun run publish-map` runs the whole sequence and publishes the result.

## After a game update

1. `doctor` to see the new build id and whether the pinned Source2Viewer still matches.
2. `bun run publish-map` (or `extract`, `tile`, `bake`, `pack-lite` by hand). The old bundle stays in `data/bundles/<old build>/`.
3. `dlq-extract diff data/bundles/<old> data/bundles/<new>` shows entity, team, tile and navmesh changes before anything is published.
4. `inspect` the new bundle; then the publish and promote steps in `docs/dev-site.md`.

Details, measured numbers and open questions are in `STATE.md`; the spec is `PLAN.md`.
