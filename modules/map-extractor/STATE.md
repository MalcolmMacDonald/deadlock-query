# map-extractor — state

- **Status:** S2 spike complete — **GO** (render, collision, entities, nav all obtainable)
- **Version:** 0.6.1 (module); `EXTRACTOR_VERSION` stays 0.3.0 (the lite render stage key now includes `materials`, so old caches are not reused)
- **Current milestone:** M0-M5 code done; M0-M4 verified on real `dl_midtown` data (2026-10-06); **navmesh (M5) real run and human sign-off pending**
- **Last updated:** 2026-10-06

## Done
- **S2 spike** (2026-10-05, Windows 11, Deadlock build `25712201`, Source2Viewer-CLI 20.0). Findings below. No game assets are committed; all outputs were written outside the repo.

## S2 findings

### Environment
- Steam AppID **1422450**, `installdir` = `Deadlock`, build id in `steamapps/appmanifest_1422450.acf` (`buildid` = 25712201). Located via `steamapps/libraryfolders.vdf` (apps map contains `1422450`).
- Install: `<library>/steamapps/common/Deadlock/game/citadel/`. Contains `gameinfo.gi`, `pak01_dir.vpk` + `pak01_NNN.vpk`, and **`maps/*.vpk`** (one self-contained VPK per map, with no `_dir` suffix).
- Maps present: `dl_midtown.vpk` (1.23 GB, **the main 6v6 map**), `dl_hideout.vpk` (387 MB), `new_player_basics.vpk` (370 MB), `hero_testing.vpk` (181 MB), `start.vpk` (178 KB) plus `scenes/`, `ui/` folders. `list-maps` = `*.vpk` in `game/citadel/maps` (needs a filter for non-gameplay maps).
- Tool: `Source2Viewer-CLI.exe` **20.0**, https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/20.0/cli-windows-x64.zip (52,735,867 B, sha256 `d32ab327b8bbb42a2528866afb03bb582bdb779d0005488da32b90292afd3ff5`). Installed to `~/tools/s2v` (outside the repo). Needs `libSkiaSharp.dll` + `spirv-cross.dll` beside it. A GUI `Source2Viewer.exe` was also present in Downloads; it is not the CLI. The docs say CLI flags may change between releases, so pin the version.
- CLI exit codes: 0 ok, 1 bad args, 2 processing failure. Errors print a .NET stack trace on stdout/stderr. `ExportFailed` should parse the first non-stack line.

### Commands that worked
`M=".../game/citadel/maps/dl_midtown.vpk"`

| Purpose | Command | Result |
|---|---|---|
| List map contents | `S2V -i $M --vpk_list` | 1,962 entries, instant |
| Entities | `S2V -i $M -f maps/dl_midtown/entities/default_ents.vents_c -o out/ents -d` | 13.8 MB text, 6,075 entities, 1.6 s |
| **Collision (physics) GLB** | `S2V -i $M -f maps/dl_midtown/world_physics.vmdl_c -o out/phys -d --gltf_export_format glb` | `phys_physics.glb` **7.2 MB**, 3 s |
| Nav files | `S2V -i $M -f maps/dl_midtown.nav -o out/navx -d` | raw binary copy (also `.navspace`, `.navflowmap`) |
| **Render GLTF** | `S2V -i $M -f maps/dl_midtown/worldnodes/n0.vwnod_c -o out/n0.gltf -d --gltf_export_format gltf` | **works as `.gltf` + 3 `.bin`** (1.07 + 1.07 + 0.75 GB + 17.6 MB json); **6 min 59 s**, ~6 GB RAM |

Notes on the commands:
- `-o` with `-f` matching exactly one file is treated as a **file path** (no extension logic). `-o` is a folder otherwise. For the physics export it wrote `phys.glb` (empty 236 B stub) and `phys_physics.glb`. The `_physics` file is the real one.
- `-d` is required to decompile or export. Without it the tool only prints a summary.
- Block dumps: `-b DATA|PHYS`. **Do not dump `PHYS`** (886 MB of text). Use the GLB export.
- A `.glb` render export of the worldnode **fails**: `NotSupportedException: ... big model (>=2GiB) exports ... Try exporting as .gltf`. So the render export must be `.gltf` + bins or split by mesh (`--gltf_mesh_list`) or the `.vmdl_c` per aggregate model.

### Map layout (`dl_midtown.vpk`, 1,962 files)
- `maps/dl_midtown.vmap_c` (392 KB), `.nav` (10.6 MB), `.navspace` (54.9 MB), `.navflowmap` (2.8 MB), `.custom.dimensions` (0.85 MB).
- `maps/dl_midtown/world.vwrld_c` (2.3 KB) → one world node **`worldnodes/n0.vwnod_c`** (373 KB) referencing **1,300 files in `worldnodes/`** (1,935 `.vmdl_c` in total; the largest merged aggregates are 13–27 MB each, e.g. `n0_lr0_agg_merge_hideout_vertex_color_3.vmdl_c`).
- `world_physics.vmdl_c` (89 MB) = the collision model. Its PHYS block holds 41 capsules, 17 hulls and 12 meshes; most bytes are mesh BVH data.
- `world_visibility.vvis_c` (15 MB), `pve_nav_cache.vdata_c` (747 KB, `CPVENavCacheBake`: nav positions + flags + nearby wall planes), 5 `.vents_c` lumps (the main one, `default_ents.vents_c` = 736 KB, plus 4 small `<id>#entitylumpname` sub-lumps: `14781_3568_158`, `14781_3568_178`, `14781_3578_158`, `14781_3578_178`), 10 `.vtex_c` (lightmaps, cubemap array, up to 121 MB — not needed).

### Render geometry
- Export of `n0.vwnod_c`: **27,314 meshes / 27,543 nodes / 29.4 M triangles**, positions + normals + tangents + 2 UV sets. **0 materials/textures** exported (the `--gltf_export_materials` flag was not passed), so geometry carries no textures and the `lite` tier is untextured by default.
- Mesh names carry the material (`..._vism0_mt_<material>`), so material identity can be recovered from names even without material export.
- Bounding box of the render: after the node transform, it reads [-512,-92,-904]..[799,367,837] in the node's local space. Node matrices are close to identity (so the units are *not* in meters). **The scale/axes of the GLB differ between render (identity, Z-up source units presumably) and physics (see below).** The contracts `glbToWorld` must be set per file.
- At 29.4 M triangles this is **far beyond** the `lite` budget (150 MB) and viewer budgets: decimation / instancing / filtering by material or layer is needed. 7 min and 6 GB are required for the full export, so cache it (PLAN §5 cached stages) and consider per-aggregate exports.

### Collision (physics) — authoritative for rays
- `phys_physics.glb`: **13 meshes, 104,241 triangles, 185,254 vertices.** Raw bbox (before node matrix) X -17356..25600, Y -16384..21344, Z -1620..13824.
- Each node carries glTF **`extras`** = `{SurfaceProperty, InteractAs[]}`, so collision layers are preserved:

| mesh | tris | InteractAs | surface |
|---|---|---|---|
| physics_Citadel_Foliage_foliage | 53,488 | Citadel_Foliage | foliage |
| physics_npcclip_playerclip | 35,849 | npcclip, playerclip | default |
| physics_window_glass | 6,194 | window | glass |
| physics_blocklight_blocklos_blocksound_solid_concrete | 6,084 | blocklight, blocklos, blocksound, solid | concrete |
| physics_passbullets_foliage | 604 | passbullets | foliage |
| physics_Citadel_Skyclip_playerclip | 616 | Citadel_Skyclip, playerclip | default |
| physics_sky | 514 | sky | default |
| physics_npcclip | 370 | npcclip | default |
| physics_passbullets | 204 | passbullets | default |
| physics_blocklos_Citadel_Obscured_NavIgnore | 182 | blocklos, Citadel_Obscured, NavIgnore | default |
| physics_playerclip | 120 | playerclip | default |
| physics_blocklos | 12 | blocklos | default |
| physics_blocklos_Citadel_Obscured | 4 | blocklos, Citadel_Obscured | default |

- **Each node has a matrix of ~0.0254 scale with a swapped basis** (`[3.0e-9,0,0.0254,0, 0.0254,3.0e-9,0,0, 0,0.0254,3.0e-9,0, 0,0,0,1]`; looks like a 0.0254 scale plus an axis permutation, unconfirmed). The accessors' raw positions are in Source units, so **apply or undo this matrix consistently**; this is the `glbToWorld` D5 needs. Record it in the bundle manifest and verify the physics and render GLBs agree (**not yet verified**, as the render export isn't in the same convention — see above).
- Fewer triangles than the render mesh by 300x: it is a clean basis for BVH. Possible concern: hulls/capsules (17 + 41) are folded into these meshes by the exporter; **not verified** whether all hulls were exported (13 output meshes vs 12 mesh shapes + 17 hulls).
- Real "solid" world collision looks small (the main part is `npcclip_playerclip` and foliage; `solid` is only 6 k triangles). **Hypothesis to check in M1: most walkable geometry may come from the render mesh / aggregate models whose physics are embedded in the individual `.vmdl_c` files, not from `world_physics`.** Ask the owner to eyeball the GLB.

### Entities (`default_ents.vents_c`, text export)
- Format: records separated by `====N====` lines, then `key  value` lines (value quoted string, `[ x, y, z ]`, or `resource_name:"..."`), then `@Output ...` connection lines. Not KV3. Includes `origin`, `angles`, `scales`, `hammeruniqueid`, `targetname` (often prefixed `[PR#]`), `subclass_name`.
- Coordinates: Source units, Z-up. Entity origins span X -17237..14957, Y -13264..12604, Z -16023..19560.
- 6,075 entities, **~90 classes**. Gameplay-relevant ones:

| class | count | notes |
|---|---|---|
| `citadel_pickup_spawner` | 36 | `subclass_name = citadel_pickup_floating_health` (all 36) = **healing orbs**; `spawn_delay_override` = 180.0 |
| `info_neutral_trooper_camp` | 52 | `subclass_name`: `neutral_camp_medium` 25, `_vaults` 11, `_strong` 11, `_weak` 4, `_midboss` 1 |
| `npc_boss_tier2` | 6 | **walkers** (`bossname` like `combine_t2_boss_yellow`, `lanenum`, `teamnumber`) |
| `npc_boss_tier3` | 2 | **patrons**; `lanenum`, `teamnumber` |
| `npc_barrack_boss` | 12 | `npc_barrack_boss_amber`/`_sapphire` (6 each) |
| `npc_base_defense_sentry` | 8 | |
| `info_super_trooper_spawn` | 12 | 6 with `subclass_name` `boss_{rebel,combine}_t1_{yellow,purple,blue}` = **Guardians' spawn points (the best candidate for T1 guardians, no `npc_boss_tier1` class exists in the map)** |
| `info_trooper_spawn` | 24 | lane trooper spawns; `lane_marker_path` (12) has `lanenum`, `laneslot`, `pathnodes` (spline list) |
| `citadel_zipline_path_node` | 129 | + `citadel_zipline_path` 5, `trigger_catapult` 17 (jump pads), `citadel_trigger_climb_rope` 17 |
| `citadel_trigger_interior` | 22 | volume entities, with `interior_type` 0 (13) / 1 (9) |
| `func_nav_markup` | 155 | nav-gen hints (`navproperty_navgen = WALKABLESEED`, `navproperty_navattributes`) |
| `info_nav_space` | 1 | nav space origin |
| `info_team_spawn` | 13, `citadel_capture_point` 2, `trigger_item_shop` 9, `trigger_midboss_shield` 1, `citadel_item_powerup_spawner` 2, `item_crate_spawn` 6, `citadel_minimap_boundary` 2, `info_mini_map_marker` 8, `citadel_tunnel_*` (177), `citadel_trigger_in_map_district` 45 | |

Other (bulk, likely out of scope): `light_omni2` 1,968, `light_barn` 755, `citadel_breakable_prop` 665, `env_soundscape` 372, `info_particle_system` 302, `env_combined_light_probe_volume` 229, `env_volumetric_fog_volume` 124, `prop_dynamic` 112, etc.
- **Volumes' extents (triggers) are not inlined in the text**: `model resource_name:"maps/dl_midtown/entities/<name>.vmdl"` refers to a per-entity model whose physics gives the volume. **Not yet exported**; needed for interior volumes and trigger shapes (to check in M1).
- `lane_marker_path.pathnodes` holds a 9-float-per-node spline: usable as lane centrelines (`lanenum` 1–3).
- Tags worth mapping in contracts `kind`: guardian (see above), walker, patron, healingOrb, creepCamp (+tier from `subclass_name`), zipline, jumpPad, interior volume, shop, spawn.
- Coordinates in entity text are Source Z-up units, matching D5 directly.

### Navigation
- **A native Source 2 nav mesh exists**: `maps/dl_midtown.nav` (10.6 MB, starts `ce fa ed fe`, i.e. 0xFEEDFACE little-endian), `.navspace` (54.9 MB), `.navflowmap` (2.8 MB). The CLI only copies them as raw binary; **their format is undocumented and not parsed by VRF** (no decode attempted).
- `pve_nav_cache.vdata_c` decompiles to KV3 `CPVENavCacheBake`: `m_vecNavPositions` (positions with `m_eFlags`, nearby wall planes, breakable placement) — a sparse sampled walkable-point cloud with **wall planes already present**; this is directly usable as validation or as seeds for `wallDistance`.
- Consequence for D4/Recast: Recast-from-collision remains the plan; the game's own nav (`.nav`) is a candidate for reverse engineering or just for QA comparison. The entities `func_nav_markup` / `NavIgnore` tags give hints (`WALKABLESEED`).

### Go / no-go
- **GO** for M0/M1: CLI works headless on Windows, exports collision (small, tagged), full render (huge; needs split/decimate), and entities (text).
- Contracts agent unblocked for entity schema (see classes above) and the manifest (physics `extras` tags, `glbToWorld`).

- **M0** (2026-10-05): `dlq-extract` CLI scaffold (`bun run dlq-extract doctor|list-maps [--json] [--game-dir]`), hand-rolled argv (no `@effect/cli`), `tools.lock.json` pin, Steam locate (`--game-dir` > `DEADLOCK_DIR` > `libraryfolders.vdf`), VDF parser, tagged errors, stable exit codes (0 ok, 1 usage, 2 problem). 6 unit tests against a fake Steam tree.
  - **Not verified on a real install:** the `Source2Viewer-CLI --version` output format (`parseVersion` takes the first `N.N` found) and `doctor` on Malcolm's machine. Run `bun run dlq-extract doctor` there; the tool is found via `S2V_CLI` or `~/tools/s2v`.
  - **Deferred:** `doctor --fix` / tool download with sha check (lock file has url+sha; `sha256File` exists, download not wired).

- **M1 code** (2026-10-06): `dlq-extract extract --map <m> [--tier full|lite] [--force] [--out dir]` and `inspect <bundle-dir>`. Stages (entities, collision, render for `full`) are cached by `(buildId, stage, s2vVersion, extractorVersion, map)` stamps; `S2VRunner` is injectable (tests use a fake). `vents.ts` parses the text lump, `entityKinds.ts` maps classes to contracts `kind` (guardian = `info_super_trooper_spawn` + `boss_*_t1_*`; healingOrb = pickup spawner with `citadel_pickup_floating_health`). `fileGlbToWorld` = inverse of the common node matrix per file (undoes the loader-applied 0.0254 swap so positions land in Source units); `inspect` warns if collision bounds after `glbToWorld` do not overlap entity bounds.
  - Tests: 13 unit tests, incl. extract+inspect+cache against the contracts mini-map GLB.

## M1 real-run findings (2026-10-05, this machine, builds 25712201 then 25738777)
- `doctor`: passes after a fix. The CLI reports `20.0.6980+<sha>` and the pin was `20.0`, so `matchesPin` failed; it now accepts `20.0.x`.
- **lite extract** of dl_midtown: 6 s. Bundle is 36 MB on disk (8.7 MB `entities.json`, 6.9 MB `collision/physics.glb`, 21 MB `.work` scratch that can be deleted). `inspect` passes: 6,075 entities (369 with a mapped kind), collision bounds in Source units X -17356..25600, Y -16384..21344, Z -1620..13824 overlap entity bounds.
- **full extract: works** (rerun after freeing disk; the game had updated to build **25738777**, which has 6,076 entities and identical collision bounds). Wall time **7 min 52 s**. Output **2.8 GB**: `render/n0.gltf` 17.6 MB + `n0_0.bin` 1.07 GB + `n0_1.bin` 1.07 GB + `n0_2.bin` 0.75 GB (tile `bytes` 2,913,550,417), collision 7.2 MB. Peak RAM was not measured this run (S2 measured about 6 GB). The first attempt died with `IOException: not enough space` on the second bin; the CLI reports that as `export failed at render: expected output missing` (follow-up: surface the first `Exception` line). No Release, nothing uploaded; output stays outside the repo.
- **Frame question settled on the full render: same frame.** Physics nodes carry one 0.0254 scale + axis permutation matrix: loaded = (y, z, x) * 0.0254, i.e. metres, glTF Y-up. Render nodes carry 8,115 distinct near-identity placement matrices in that same loaded frame. Render loaded bounds [-512,-92,-904]..[799,621,837] enclose physics loaded bounds [-416,-41,-441]..[542,351,650]. With the physics `glbToWorld` applied, render bounds are X -35585..32945, Y -20170..31437, Z -3640..24435 Source units and enclose collision X -17356..25600, Y -16384..21344, Z -1620..13824. Bug fixed: `extract` took the inverse of the render file's most common node matrix (about identity), so the manifest's render `glbToWorld` claimed Source units. It now always reuses the physics file's matrix.
- Render content: 12 material names recovered from mesh names (glass, black, cosmic_veil). The lite tier still has no render until the triangle cut (29.4 M tris) is settled.
- Open: hull completeness (b), per-entity volume models (c), triangle cut for `lite` (d) are unchanged.

- **Materials + in-repo output** (2026-10-06): render export now passes `--gltf_export_materials` (glTF materials + textures written beside `n0.gltf`); tile `bytes` counts every file under `render/`; extractor 0.2.0 (invalidates cached render stages). Default `--out` is `<repo>/data/bundles` regardless of cwd; `extract` drops a `.gitignore` (`*`) into the output root so bundles are never committed (the root `.gitignore` is out of module scope). **Not run against a real install:** texture volume/time of the full export is unknown, and the Source2Viewer `--gltf_export_materials` flag name comes from VRF docs, not a real run. Check `dlq-extract extract --tier full --force` on the dev machine and watch disk (render was already 2.8 GB).

- **Lite render tier** (2026-10-06, extractor 0.3.0): `--tier lite` now exports the full world node into `.work/render-full` (same ~8 min, ~3 GB, plus textures), then `src/liteRender.ts` reduces it: keeps the largest primitives (bbox diagonal) up to `--tri-budget` (default 5 M of 29.4 M), bakes node matrices into the vertices, buckets by 128 m grid cell on loaded X/Z, splits cells to stay under 18 MB per `.glb`, one primitive per material, carries glTF materials and copies referenced texture files unmodified into `render/`. Tiles land in `render/tiles/*.glb` with per-tile bounds/materials in the manifest; the full export is deleted afterwards unless `--keep-work`. Tests use a synthetic glTF (selection, baking, materials/images, tile splitting); **not run on real data**.
  - Known limits: no real decimation (small props are dropped entirely, so interiors/detail will be missing); textures are not downsized, so the 900 MB site budget may be exceeded once real texture volume is known; vertex data is plain float32 (32 B/vertex), so quantisation would roughly halve tile size; primitives over the tile budget are dropped with a warning; non-triangle modes are skipped.
  - Next: run `dlq-extract extract --tier lite --force` on the dev machine, check `inspect`, tile sizes, texture MB and the warning line; tune `--tri-budget`; then publish with `tools/publish-data.ts` (infra).

## M2 (2026-10-06)

- **`pack-lite` command** (extractor 0.3.0, with pack-lite): validates lite-tier bundles for publishing. Checks:
  - Manifest tier is "lite" (rejects "full")
  - No texture files (`.png`, `.jpg`, `.webp`, `.ktx2`, `.basis`, `.tga`, `.bmp`)
  - Bundle size < 900 MB (site budget)
  - Individual tile files < 20 MB (per-tile budget)
  - Reports buildId, mapName, total size, tile count, texture file count, collision size
  - 3 unit tests: valid lite bundle passes; non-lite bundle rejected; no-manifest error
- Next: run `dlq-extract pack-lite <bundle-dir>` on dev machine after `extract --tier lite` to verify budget compliance; then ready for M3 (tiling/LOD).

## M3 (2026-10-06)

- **`dlq-extract tile <bundle-dir> [--lods 2] [--lod-ratio 0.25] [--keep-textures]`** (`src/tiling.ts`), run after `extract --tier lite`, before `pack-lite`. Lite tier only (the full tier is one multi-GB glTF and is rejected).
  - Per tile: reads the GLB, drops textures (PLAN §5.9: lite is untextured; the copied texture files are deleted unless `--keep-textures`, in which case images get embedded in the GLB), welds vertices, then writes LOD0 in place and LOD*n* as `<id>.lod<n>.glb`. Each is `prune`d, quantised (KHR_mesh_quantization, 14-bit positions) and meshopt-compressed (EXT_meshopt_compression, level high). LOD*n* keeps `lodRatio^n` of LOD0's triangles via the meshoptimizer simplifier (error bound 2 % of the extent).
  - Manifest: LOD0 keeps the tile id; LODs are separate tiles with id `<id>#lod<n>`, the same `bounds`, their own `bytes`/`sha256`. Bounds stay in the loaded frame transformed as before (quantisation puts scale/offset on the node, so decoded geometry is unchanged in frame).
  - Fails (exit 2) when any tile file exceeds 20 MB, when the bundle is not lite, or when it already has `#lod` entries (re-run `extract --tier lite --force`).
  - **Viewer decoder contract:** tiles need `MeshoptDecoder` (EXT_meshopt_compression, required) and a loader that supports KHR_mesh_quantization (three's `GLTFLoader` does). No Draco.
  - `pack-lite` now checks the size of every tile file named in the manifest (it used to look only at `render/*.glb`, so `render/tiles/*.glb` and LOD files were skipped) and flags missing tile files.
  - Tests: 5 for `tile` on synthetic grid tiles (LOD triangle counts, manifest ids/bytes/sha256, quantised bounds survive meshopt decode, texture stripping, budget error, rejection paths), 1 for the `pack-lite` manifest check.
  - **Not run on real data.** Real tiles are the 18 MB cell tiles from `extract --tier lite`; compression time and the final size against the 900 MB site budget are unknown.

## M4 (2026-10-06)

- **`dlq-extract bake <bundle-dir> [--cell-size 64] [--exclude-layers a,b] [--force]`** (`src/bake.ts`), run on any bundle that has a collision reference (lite or full, before or after `tile`). Writes `<bundle>/baked/collision.bvh` and `<bundle>/baked/sample-grid.bin`, then adds a `baked` record to `manifest.json` (other manifest fields are untouched).
  - **Collision BVH:** every triangle mesh in `collision/physics.glb` merged into one soup in Source units (`collision.glbToWorld` x node world matrix, winding flipped if the transform mirrors), nodes whose `InteractAs` contains an excluded layer skipped, then `Raycaster.fromGeometry(...).serialize()` from spatial-core. Default excluded layers: `sky`, `Citadel_Skyclip` (a sky lid would make every cell interior). Everything else (foliage, playerclip, npcclip, window, solid ...) stays; layer-aware rays are a spatial-core/semantics question.
  - **Sample grid:** `SampleGrid.build` over the collision bounds, XY snapped outwards to multiples of the cell size (BVH bounds carry an epsilon; aligned cells compare across builds). Channels: built-in `floorHeight`, plus `interior` (u8, `isInterior` at the floor point, 0 where there is no floor) and `wallDistance` (f32, `nearestWall` distance, saturating at `maxRange` when no wall is in range, NaN where there is no floor). Cost is about `1 + 1 + wallRays` rays per cell: ~34 with the defaults.
  - **Manifest `baked`:** `{ bakeVersion, semanticsVersion, placeholder, inputKey, bvh{file,bytes,sha256,triangles,vertices,excludedLayers,skippedNodes}, sampleGrid{file,bytes,sha256,cellSize,nx,ny,origin,channels,params} }`. `placeholder` mirrors spatial-core's `PLACEHOLDER_SEMANTICS`; `semanticsVersion` is a content hash of `spatial-core/src/semantics/*.ts` plus the params, so editing the owner functions changes it. `inputKey` covers collision sha256, glbToWorld, layers, cell size, semantics hash, placeholder flag and bake version: an equal key with the files present makes `bake` a no-op ("cached"); `--force` rebuilds. Output is byte-deterministic (tested).
  - `inspect` now checks that the baked files exist and match the manifest sizes, and warns when channels were computed with placeholder semantics.
  - Tests (`test/bake.test.ts`, on the contracts mini-map): BVH and grid round-trip via spatial-core with hand-computed goldens (lane floor 0, ledge 600, roof 420, wall distance 12, no floor outside), channels equal direct semantics calls, determinism, cache hit/miss, layer exclusion, `glbToWorld` applied, error paths.
  - **Not run on real data.** Expected scale: ~104k collision triangles, a 671 x 590 grid at 64 units (~400k cells, ~13M rays). The mini-map bakes 12k cells in ~0.5 s, so a few tens of seconds to a few minutes is likely; unmeasured.
  - **Known limits:** (1) `floorHeight` is spatial-core's built-in topmost-surface ray, so under roofs/bridges the "floor" is the roof and `interior` is 0 there (the mini-map building cell reads 420 / not interior). Needs a spatial-core change (e.g. walkable-surface selection or multi-layer grid) before `interior` is meaningful in buildings. (2) Single-threaded; PLAN §5.8 wants worker threads, deferred until a real run shows it matters. (3) Navmesh is M5, not here.

## M5 (2026-10-06)

- **`bake <bundle-dir>` now runs a second stage, the navmesh** (`src/navmesh.ts`), after the collision BVH + sample grid; `--no-navmesh` skips it. It writes `baked/navmesh.bin` (spatial-core `NavMesh.serialize()` format: convex polygons in Source units, Z up, plus off-mesh links) and an OBJ for visual QA at `<bundle>.qa/navmesh.obj` (a sibling of the bundle dir, so it never counts against the pack-lite budget; `--qa-dir <dir>` / `--no-qa`). The manifest gets `baked.navmesh` (file, sha256, polygon/vertex/tile/link counts, components, `largestComponentShare`, agent + Recast parameters, excluded layers, cache key). The cache key covers collision sha256, `glbToWorld`, layers, agent, Recast params and `entities.json`; an equal key is a no-op, `--force` rebuilds. The collision/grid stage keeps `baked.navmesh` when it re-runs. `inspect` checks the file and prints polygon/component counts.
- **Recast setup:** `recast-navigation` (WASM, bake only) `generateTiledNavMesh` on the collision soup (same `loadCollisionMesh` as the BVH), Source (x, y, z) mapped to Recast (x, z, -y) (a rotation, so winding and "up" survive) and mapped back. Defaults, all CLI flags: agent radius 16, height 72, climb 18, slope 45 degrees (Source-engine defaults, **not measured from Deadlock heroes**), cell 8 x 4, tile 128 voxels (1024 units), max 6 vertices per polygon. Excluded layers (`--nav-exclude-layers`): `sky`, `Citadel_Skyclip`, `Citadel_Foliage`, `NavIgnore`; `playerclip`, `npcclip`, `window` and `passbullets` stay in (they block movement; npcclip-only nodes are included too, since layer matching is per node and cannot express "only").
- **Tile borders:** Recast tiles connect by portal overlap, not shared vertices, but spatial-core builds adjacency from shared polygon edges. After welding vertices across tiles (same xy cell, height within the agent climb), `stitchTileBorders` splits boundary edges on tile border lines so both sides share identical sub-edges (only vertices at a matching height count, so bridges over ground are not merged). Counted as `stitchedEdges` in the manifest. The synthetic mini-map has aligned tile borders (0 stitched), so the stitcher is covered by T-junction unit tests; whether real geometry needs it is unmeasured.
- **Links (unverified):** `entityLinks` turns `zipline` nodes (`target` -> next node's `targetname`, bidirectional) and `jumpPad` entities (`launchTarget` -> entity `targetname`, one way) into `NavLink`s of kind `zipline` / `jumpPad`; endpoints more than 256 units from any navmesh vertex are dropped (`links.dropped`, plus a warning). **These property names are a guess**; the S2 survey recorded classes and counts but not the zipline/catapult key names, so the real run may yield 0 links (it warns in that case). Check the `citadel_zipline_path_node` / `trigger_catapult` records in `entities.json` and fix the keys.
- **QA/sign-off:** open `<bundle>.qa/navmesh.obj` (one group per connected component, 0 = largest). Things to eyeball: the main lanes and bases are in component 0; stairs/ramps are connected; rooftops and enclosed rooms are separate components only where they should be; no navmesh on the sky lid or inside foliage; zipline/jump pad links where expected. Record the verdict under "Navmesh sign-off" below.
- Tests (`test/navmesh.test.ts`, 9): weld/stitch/component/OBJ/link helpers on hand-built polygons (T-junction stitched, other-level vertices not), and the Recast bake on the contracts mini-map with 32-voxel tiles: dominant component > 80%, a path across ~15 tile borders along lane 1 (cost 7000..7600), the lane-2 wall forcing a detour (cost 7000..8500, a point with |y| > 300), the ledge unreachable, deterministic bytes, cache hit/miss, agent change re-keys, `inspect` passes, `baked.navmesh` survives a bake re-run, error paths.
- **Not run on real data.** Expected scale: ~1500 tiles at the default tile size; no progress callback exists inside Recast's tiled generator, so a long real run only logs before and after. Memory/time unmeasured. If it is too slow, drive `generateTileNavMeshData` tile by tile (progress, worker threads) instead of `generateTiledNavMesh`.

## Navmesh sign-off
- Pending: needs a human to look at the OBJ from a real `bake` (see M5 above).

## Real-data run: lite pipeline on dl_midtown (2026-10-06, build 25738777, Windows 11, 39 GB free on C: before)

`extract --tier lite --keep-work`, `tile`, `bake`, `pack-lite` (default `--tri-budget` 5 M, `--lods 2`, `--lod-ratio 0.25`, bake cell 64), then contracts `check:real`.

| Step | Wall time | Output |
|---|---|---|
| `extract --tier lite` | about 7 to 8 min: Source2Viewer render export about 7 min 45 s (peak about 3 GB RAM, 1.1 GB per `.bin`), reduction about 1 to 2 min | `render/tiles`: 63 tiles, **281 MB**, 5.0 M of 30.0 M triangles; `collision/physics.glb` 6.9 MB; `entities.json` 6,076 entities |
| `tile` | 14 s | 126 files (63 LOD0 + 63 LOD1): LOD0 **63.1 MB**, LOD1 **39.8 MB**, total **102.9 MB** (281 MB before: 2.7x smaller), largest tile **4.2 MB**; quantiser skips `TEXCOORD_0` outside [0,1] (harmless: lite has no textures) |
| `bake` | 24 s | BVH 5.4 MB (103,174 triangles after dropping `sky` and `Citadel_Skyclip`, 2 nodes skipped), grid **333 x 385 cells of 64** (origin -10368,-12288), 1.1 MB, **109,090 / 128,205 cells (85.1 %) have a floor** |
| `pack-lite` | under 1 s | **124.6 MB** total (budget 900 MB), 126 tiles, 0 texture files, ok |
| `inspect` | under 1 s | ok; placeholder semantics warning |
| contracts `check:real` | under 1 s | ok (see contracts STATE) |

Disk: the lite bundle is 125 MB published; transient scratch is about 2.8 GB (`.work/render-full`, deleted after `extract` unless `--keep-work`) plus the 1.8 GB of textures the CLI writes if `--materials` is passed. Plan for about 4 GB free for a lite run.
- All 375 entities that have a normalised kind lie inside the baked grid footprint (the sky lid removal shrinks it from the 42,956 x 37,728 collision bounds to 21,312 x 24,640).
- LOD1 keeps about 68 % of LOD0 triangles on the sampled tiles (e.g. 15,728 -> 10,677), not the 25 % `--lod-ratio` asks for: the 2 % error bound stops the simplifier first. Tune before relying on LOD1 for far views.
- The grid is the topmost-surface floor (see M4 limits), so 85.1 % "has floor" includes roofs.

### Bugs the real data exposed (fixed in this change)
1. **`--gltf_export_materials` breaks the render export.** With it, Source2Viewer 20.0 logs a `VCS file version 72` exception per material, writes 1,533 textures (1.8 GB) and the three `.bin` files, then never writes `n0.gltf` (once it exited without it, once it idled for hours). `extract` then crashed with `ENOENT .../n0.gltf`. The flag is now opt-in (`extract --materials`, off by default); lite does not need it (untextured, PLAN section 5.9).
2. **Lite reduction copied whole vertex buffers.** Aggregate fragments share their mesh's vertex buffer and index a small part of it, so a 1.19 M-triangle selection produced **4.1 GB** of tiles and 1,722 of 2,317 chosen primitives were "over budget" and dropped. `liteRender` now sizes, bounds and emits only the referenced vertices (and reads tightly packed accessors with a fast path): the same 5.0 M triangles are **281 MB**, nothing dropped. Oversize drops are now one summary warning, not one line each.
3. **Guardians were never mapped.** The real `info_super_trooper_spawn` carries `bossname` (e.g. `boss_rebel_t1_blue`), not `subclass_name`; `entityKind` input now takes either. `entities.json` has **6 guardians** (was 0). The test fixture uses the real shape.
4. **`pack-lite` counted scratch.** `.work/` and `.stage-*` were summed into the 900 MB budget though `publish-data` excludes them; they are now listed as a note and excluded from the total.

## In progress
- M5 navmesh real run (see below, once recorded).

## Next
1. M5 on real data: `bake` now also builds the navmesh; run it on the real bundle, note polygon count, component share and run time, open `<bundle>.qa/navmesh.obj`, fix the zipline/jump pad property names if `links` is 0, tune `--agent-*` / `--nav-exclude-layers`, record the sign-off. Then M6 (caching/resume/`diff`, README, update runbook).
2. Triangle cut quality (open question d): 5 M of 30 M triangles chosen by bbox diagonal drops small props and interiors. Render the lite tiles in map-viewer next to the collision GLB and tune `--tri-budget` (the whole lite bundle is only 125 MB, so there is room to raise it a lot), or add a real decimation pass. Check `tile` LOD1 ratio at the same time.
3. Open questions: (a) physics vs render frame **settled, same frame** (see M1 findings); (b) all hulls exported and (c) per-entity volume models (interior/trigger shapes) still open.
4. Check `dl_hideout` / `new_player_basics` only if the owner wants them (not in Slice 1).

## Blockers / Requests to other modules
- spatial-core: (a) export a `SEMANTICS_VERSION` (bake currently hashes `semantics/*.ts` at run time); (b) `floorHeight` is the topmost surface, so interior cells under a roof are not detected, and row-range/worker-friendly `SampleGrid.build` would let `bake` parallelise.
- contracts: `manifest.baked` is `Record<string, unknown>`; bake writes the shape documented under M4. Contracts M3 (baked-data specs) should adopt it (or tell us what to change), including `semanticsVersion` and `placeholder`.
- contracts: `Tile` has no `lod` (or `lods[]`) field, so LODs are encoded as separate tiles with id `<id>#lod<n>` and a shared `bounds` (see M3). A `Tile.lod` / `Tile.lodOf` field would let the viewer select LODs without parsing ids; map-viewer M4 should read this convention until then.
- contracts: `manifest.baked.navmesh` shape is documented under M5; the navmesh binary is spatial-core's `NavMesh.serialize()` layout (contracts has no spec yet). Contracts M3 (baked-data specs) should adopt it.
- root (optional): add `data/` to `.gitignore`; the extractor already self-ignores its output root.
- contracts: `Tile` has a single `file`; the render export is `n0.gltf` + 3 `.bin` (>1 GB each). Tile `bytes` currently sums the bins and `sha256` covers the `.gltf` only. Consider `Tile.files[]` or a size-limit/tiling note (M3).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-05 — Branch is `main`; bake calls spatial-core semantics (placeholder-aware).
- 2026-10-05 — S2: main map is `dl_midtown` (not `dl_*` generic); Source2Viewer-CLI 20.0 pinned as the first tested version; render export must be `.gltf` (+bins), not `.glb`, because of the 2 GiB limit.

- 2026-10-05 — M0: no `@effect/cli` yet (two commands); hand-rolled parser, swap when `extract` flags grow. Tool path via `S2V_CLI` or `~/tools/s2v`.

- 2026-10-06 — M1: lite tier omits render geometry for now (collision + entities only) rather than guess a decimation; full tier exports `n0.vwnod_c` as `.gltf`. Hand-rolled argv kept.

- 2026-10-06 — M2: `pack-lite` validates lite-tier bundles for publishing (tier check, texture verification, budget compliance). No real-data testing yet; unit tests pass. Not yet integrated with the publish workflow (that lives in infra/tools/publish-data.ts).

- 2026-10-06 — M3: `tile` is a separate step after `extract --tier lite` (not folded into `extract`) so the 8-minute export stays cached and LOD settings can be re-tried; LODs are separate manifest tiles (`#lod<n>`) because contracts' `Tile` has a single `file`; meshopt (not Draco) so one WASM decoder serves the viewer; lite tier drops textures at this step.

- 2026-10-06 — M4: bake is its own command after `extract`/`tile` (collision is already in the bundle); collision soup excludes `sky` and `Citadel_Skyclip` by default; grid channels are `interior` (u8) and `wallDistance` (f32, saturating at `maxRange`) wired to spatial-core semantics, `floorHeight` built in; cache key in the manifest rather than stage stamps, because bake mutates `manifest.json`; `semanticsVersion` is a source hash until spatial-core exports one.

- 2026-10-06 — M5: navmesh is a second stage of `bake` (default on, `--no-navmesh` to skip) so one command yields all baked data and the manifest keeps one `baked` record; tiled Recast + explicit tile-border stitching rather than a solo mesh, because a solo build of the ~43k x 38k unit map at cell 8 would be a ~25M-column heightfield; agent size defaults are Source-engine values until measured; QA OBJ lives beside the bundle, not in it, so pack-lite never counts or ships it; zipline/jump pad link keys are guesses and flagged.

- 2026-10-06 - Real run: `--gltf_export_materials` is opt-in because it hangs the real export; lite tile reduction emits only referenced vertices; guardian marker is read from `bossname` as well as `subclass_name`; `pack-lite` size excludes scratch.

## Open questions
- (see PLAN.md §9, and "Next" item 2 above)
