# map-extractor — state

- **Status:** S2 spike complete — **GO** (render, collision, entities, nav all obtainable)
- **Version:** 0.8.1 (module); `EXTRACTOR_VERSION` 0.4.0 (unchanged on purpose: the new `nav` stage must not invalidate the cached multi-GB render stages)
- **Current milestone:** M0-M5 code done and run on real `dl_midtown` data (2026-10-06). **Walkable collision solved by reading the game's own `.nav`** (see "Walkable surface from the game's nav"); navmesh visual sign-off pending
- **Last updated:** 2026-10-07

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
| `info_super_trooper_spawn` | 12 | 6 with `subclass_name` `boss_{rebel,combine}_t1_{yellow,purple,blue}` (the game's "purple" lane is **Green**) = **Guardians' spawn points (the best candidate for T1 guardians, no `npc_boss_tier1` class exists in the map)** |
| `info_trooper_spawn` | 24 | lane trooper spawns; `lane_marker_path` (12) has `lanenum`, `laneslot`, `pathnodes` (spline list) |
| `citadel_zipline_path_node` | 129 | + `citadel_zipline_path` 5, `trigger_catapult` 17 (jump pads), `citadel_trigger_climb_rope` 17 |
| `citadel_trigger_interior` | 22 | volume entities, with `interior_type` 0 (13) / 1 (9) |
| `func_nav_markup` | 155 | nav-gen hints (`navproperty_navgen = WALKABLESEED`, `navproperty_navattributes`) |
| `info_nav_space` | 1 | nav space origin |
| `info_team_spawn` | 13, `citadel_capture_point` 2, `trigger_item_shop` 9, `trigger_midboss_shield` 1, `citadel_item_powerup_spawner` 2, `item_crate_spawn` 6, `citadel_minimap_boundary` 2, `info_mini_map_marker` 8, `citadel_tunnel_*` (177), `citadel_trigger_in_map_district` 45 | |

Other (bulk, likely out of scope): `light_omni2` 1,968, `light_barn` 755, `citadel_breakable_prop` 665, `env_soundscape` 372, `info_particle_system` 302, `env_combined_light_probe_volume` 229, `env_volumetric_fog_volume` 124, `prop_dynamic` 112, etc.
- **Volumes' extents (triggers) are not inlined in the text**: `model resource_name:"maps/dl_midtown/entities/<name>.vmdl"` refers to a per-entity model whose physics gives the volume. **Not yet exported**; needed for interior volumes and trigger shapes (to check in M1).
- `lane_marker_path.pathnodes` holds a 9-float-per-node spline: usable as lane centrelines. The real map has no `lanenum` on any entity (see the lane decision below), and `laneslot` is a slot within a lane, not a lane.
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
- **Links (keys fixed in the real run, see above; text below is the original design):** `entityLinks` turns `zipline` nodes (`target` -> next node's `targetname`, bidirectional) and `jumpPad` entities (`launchTarget` -> entity `targetname`, one way) into `NavLink`s of kind `zipline` / `jumpPad`; endpoints more than 256 units from any navmesh vertex are dropped (`links.dropped`, plus a warning). **These property names are a guess**; the S2 survey recorded classes and counts but not the zipline/catapult key names, so the real run may yield 0 links (it warns in that case). Check the `citadel_zipline_path_node` / `trigger_catapult` records in `entities.json` and fix the keys.
- **QA/sign-off:** open `<bundle>.qa/navmesh.obj` (one group per connected component, 0 = largest). Things to eyeball: the main lanes and bases are in component 0; stairs/ramps are connected; rooftops and enclosed rooms are separate components only where they should be; no navmesh on the sky lid or inside foliage; zipline/jump pad links where expected. Record the verdict under "Navmesh sign-off" below.
- Tests (`test/navmesh.test.ts`, 9): weld/stitch/component/OBJ/link helpers on hand-built polygons (T-junction stitched, other-level vertices not), and the Recast bake on the contracts mini-map with 32-voxel tiles: dominant component > 80%, a path across ~15 tile borders along lane 1 (cost 7000..7600), the lane-2 wall forcing a detour (cost 7000..8500, a point with |y| > 300), the ledge unreachable, deterministic bytes, cache hit/miss, agent change re-keys, `inspect` passes, `baked.navmesh` survives a bake re-run, error paths.
- **Not run on real data.** Expected scale: ~1500 tiles at the default tile size; no progress callback exists inside Recast's tiled generator, so a long real run only logs before and after. Memory/time unmeasured. If it is too slow, drive `generateTileNavMeshData` tile by tile (progress, worker threads) instead of `generateTiledNavMesh`.

## All triangles and baked colours, part 1 (2026-10-07)

Malcolm asked for colours on the map's model and to keep all triangles. Where the triangles went on dl_midtown (from the decimation run above): 30.0 M in 27,690 primitives; 4,422 primitives (about 3.0 M) kept at full detail, 18,083 decimated from 24.4 M to 2.0 M, about 2.6 M in the 5,185 primitives dropped outright once the 5 M budget ran out; then `tile` LOD1 on top.
- `extract --tier lite` now keeps **every triangle** by default (`triBudget` defaults to unlimited; `--tri-budget <n>` still caps it, with the old largest-first plus decimation behaviour). A primitive whose tile estimate exceeds the tile byte budget is **split** along its longest axis into tile-sized parts instead of being dropped (`splitTriangles` in the result).
- `tile` makes **3 LODs** by default (LOD1 about 25 %, LOD2 about 6 %) with error bound 0.1 of the tile (`--lod-error`), because every visible cell holds its coarsest LOD first and LOD0 is now much bigger. LOD tiles also carry `lod` / `lodOf` in the manifest (the viewer reads them; `#lod<n>` ids stay).
- **Colours**: `src/colors.ts` (mip chains, linear-light averaging, `ColorProvider`), `src/png.ts` (`fast-png`), and `buildLiteTiles({ colors })` bakes a `COLOR_0` (RGBA8, linear) per vertex: material tint x base-colour texture sampled at the vertex UV on the mip level that matches the primitive's vertex spacing in UV space (a coarse prop gets its average colour, a dense mesh real detail), x the export's own `COLOR_0` if it has one. Unresolved materials get the provider's fallback colour and are listed. UVs are not written when colours are baked. `tile` keeps `COLOR_0` through weld, simplify and meshopt (tested).
- Not done yet: the stage that builds paints from the game (`.vmat_c` / `.vtex_c` through Source2Viewer). Until then no provider is passed, so tiles carry no colours. Textures stay out of the bundle (`pack-lite` still rejects them), colour lives in vertices.
- Not run on real data. Size of the all-triangle bundle against the 900 MB site / 20 MB tile budgets is being measured on Malcolm's machine.

## Baked colours from the game's materials (2026-10-07, extractor 0.5.0)

Probe on Malcolm's machine (dl_midtown build 25761866): the glTF export has **no materials** (`materials[]` empty, no `material` index; `--gltf_export_materials` still breaks), but **`COLOR_0` (VEC4 float) is on 16,362 of 27,381 primitives (72.5 % of triangles)**, and mesh names carry the material: `n0_lr0_agg_merge_<material>_<k>[_fragment<j>]` (76.7 % of triangles, 405 stems, every stem is the basename of a `.vmat_c` in `pak01`), `n0_lr0_agg_prop_<model>_<k>_fragment<j>` (21.8 %: a model in the map vpk, `maps/<map>/worldnodes/<model>.vmdl_c`, whose "Resource External Refs" list its material; 98 % of those models have one material) and 12 `_mt_<name>` glass names. `-d` cannot decompile `.vmat_c` here (VCS 72) but `-i <raw .vmat_c> -b DATA` prints the KV3 text; `.vtex_c` exports to PNG with `-d`.
- **All triangles fit the budgets** (probe, before colours, 2 LODs): 29,949,414 / 29,949,414 triangles, 130 LOD0 tiles, LOD0 325.6 MB + LOD1 159.8 MB = 485 MB, `pack-lite` 513.5 MB of 900 MB, largest tile 4.75 MB of 20 MB. Extract 104 s, tile 89 s (2.3 GB RSS). Colours add about 1 B per vertex compressed (flat per-material colour compresses well; measure on the real run).
- `extract --tier lite` now builds **paints** (`src/materials.ts`, `src/vmat.ts`) unless `--no-colors`: mesh names -> `.vmat_c` (basename match, `materials/` preferred; props through their model's first material) -> raw extract + `-b DATA` text -> base-colour texture (`g_tColor`, `g_tColor1`, `g_tColor2`, skipping masks and `default_*`) -> PNG -> 128 x 128 mip chain (cached under `.work/paints`, so a rerun calls Source2Viewer not at all) and `g_vColorTint` when set. Per vertex: texture at the vertex UV (mip chosen from vertex spacing) x tint x the export's own `COLOR_0` rgb (its alpha is a layer-blend weight, dropped). Materials that cannot be resolved (and anything without a name pattern) get a fallback grey 0.4 linear, times their vertex colour. Warnings list the counts and the first unresolved names.
- Not applied: the layered shader's other parameters (`g_vColorTint2`, contrast / saturation / brightness, world overlays, blend masks, `g_fVertexColorStrength`), so blended materials show their base layer times the vertex colour, not the engine's exact result. Alpha-tested foliage is not special-cased.
- Not run on real data yet (probe commands and sizes above are real; the paint stage is tested against a fake Source2Viewer using the real KV3 text).

## White blobs in the published render (2026-10-07, extractor 0.5.1)

UX pass on the published bundle (build 25761866, extractor 0.5.0, 414 tiles, 424 MB) found white lumps and slabs: tree canopies at the edge of the park, big flat white planes and cloud-like masses at the map edge, and some small tiles at high Z that are white all through. Rendered the real bundle in the viewer (software GL) and measured `COLOR_0` in every LOD0 tile: **10.1 % of the 33.0 M vertices have every channel at 0.99 or more**, while 0.9 to 0.99 holds only 1 %. Real albedo does not pile up at exactly 1, so these are saturated bakes (material with no real colour: a 1 x 1 white texture and a white or absent vertex colour, a white tint with no texture, an effect or sky card), not light paint. It comes from the colour bake, not from the all-triangles change or the LOD pass (a LOD tile only keeps vertices of its LOD0 tile).
- Fix (this change): a baked colour with every channel at least `WHITE_FLOOR` (0.97 linear) is painted the fallback grey instead, and a colour that goes above 1 in a channel is scaled back by its largest channel (hue kept) instead of clamped toward white. `LiteResult.colors` gains `whitened`, `overbright` and `whiteMeshes` (the 20 meshes with most whitened vertices); `extract` prints them in its warnings, so the next run names the materials behind the white. The lite tile cache key now includes a colour revision, so old tiles are rebuilt.
- Cost: genuinely white things (white paint, marble) now read as the same light grey as unresolved materials. Pale paint (0.9 linear) is kept.
- Not yet checked on real data: which materials the whites are (needs the `.work/paints` dumps and `render-full` on the laptop; look at the `whiteMeshes` warning) and a re-published bundle. Dark patches (a few buildings and roofs bake near black, probably alpha-padded texels in the mip average) are a separate follow-up.
- **Dark bake fix (2026-10-07):** `buildMips` now leaves fully transparent texels (alpha 0, usually black padding) out of the colour average at every level (unless a whole block is transparent), the mip cache key and the lite colour revision (`colorRev` 3) changed so old caches rebuild. Needs a re-extract + republish to show; not yet checked on real data.
- Also found: LOD1 is 32.6 % and LOD2 30 % of LOD0 triangles on the published bundle (targets 25 % and 6 %): the tiles are triangle soup (about 1.7 vertices per triangle), so the simplifier barely collapses them. Follow-up.
- **LOD cut fix (2026-10-07):** `tile` now strips NORMAL, TANGENT and TEXCOORD_* from untextured (lite) tiles before welding. The viewer flat-shades and the lite tier has no textures, so those attributes only split seams and hard edges into separate vertices (the soup that stopped the simplifier at ~33 % / 30 %). Welding on position + colour should let LOD1/LOD2 reach the 25 % / 6 % targets and shrinks LOD0 as well. Not measured on real data: re-run `tile` on the laptop and check `tile` triangle counts per LOD, then republish.

## Team from names (2026-10-07) — needs Malcolm's confirmation
The real entities carry no `teamnumber`, so `team` is derived from the names in `src/teams.ts` (`TEAM_BY_NAME_TOKEN`, the one table to edit) for guardians, walkers, patrons, barracks and base sentries. **Guessed default:** amber = 2, sapphire = 3 (Source's two playing teams) and combine = 2 (Amber), rebel = 3 (Sapphire). The barracks names (`npc_barrack_boss_amber` / `_sapphire`) are exact; only the combine/rebel pairing and which colour is 2 or 3 are unverified. An explicit `teamnumber` always wins. If wrong, swap the numbers in the table and re-extract; nothing else changes.

## Real-data check of bundle 25763945 (2026-10-07)
Checked the published release (extractor 0.5.1, bake 1.1.0) and the raw entity lump on the laptop.
- **Works:** 6 guardians; lane on 6 guardians, 6 walkers, 12 barracks and all 129 zipline nodes (yellow 46, blue 37, green 46); `floorLevels` and `floorHeightLower` channels present (8,898 multi-level cells); zipline links 105 with 0 dropped (was 3 paths), navmesh `componentsWithLinks` 922 with the largest component holding 92.2 % of polygons once links count.
- **Not in this bundle yet:** `team` (PR 190) and interior volumes (PR 192) were still unmerged when it was built; `interiorSource` is absent.
- **Bug found and fixed:** `pathnodes` is a triple-quoted block (`pathnodes  """` ... `"""`) in the real lump, so the single-quote handling never engaged and the lines still became junk keys (`"0.0,"`). The parser now reads `"""` blocks as one flat number list; the 5 zipline paths give 37 / 46 / 46 nodes of 9 numbers each (the 129 nodes), the 2 others 4-number rows (lane markers, not decoded). Lights (`light_barn`, `light_omni2`) still carry comma keys from some other multi-line value; harmless, left alone.
- `interior_type` is a string (`"0"` / `"1"`) in the lump, not a number; interior entities name their model (`maps/dl_midtown/entities/<name>_<id>.vmdl`) as expected.

## Mantle links (2026-10-07)
The upper platforms with no way up (see the islands finding) now get upward links mirrored from the game's one-way drops: each `navConnection` drop of 48 to 1600 units becomes a reverse one-way link of kind `mantle` (`mantleLinks`, `NAVMESH_BAKE_VERSION` 1.2.0). Tunables in `navmesh.ts`: `MANTLE_LINKS` (false stops them), `MANTLE_MIN_DROP`, `MANTLE_MAX_RISE`. On bundle 25763945: 1,304 mantle links; with `mantle` at half walking speed, unreachable healing orbs drop from 15 of 36 to 1 and the spawn becomes reachable; the 3 remaining camps and 1 orb and the powerup are the small fragments fixed by the island-stitch change. **For query-library / query-builder:** give `mantle` an entry in `linkSpeeds` (suggested 0.5 x walking speed) or queries will not use it; leave it out to forbid climbing. Drops are used as a stand-in for climbability: a platform reachable only by a rise the player cannot really make will look reachable. Needs `bake --force` and republish.

## Navmesh sign-off
- 2026-10-07: Malcolm looked at the game-nav navmesh OBJ (`lite.qa/navmesh.obj`, build 25761866) and said it looks good. Signed off for the game-nav source; the Recast fallback is not signed off (its input is the clip volumes). Hull choice (`--flow-hull`, default 0) is still unverified.

## Real-data run: lite pipeline on dl_midtown (2026-10-06, build 25738777, Windows 11, 39 GB free on C: before)

`extract --tier lite --keep-work`, `tile`, `bake` (collision BVH + sample grid + navmesh, M5), `pack-lite` (default `--tri-budget` 5 M, `--lods 2`, `--lod-ratio 0.25`, bake cell 64), then contracts `check:real`.

| Step | Wall time | Output |
|---|---|---|
| `extract --tier lite` | about 7 to 8 min: Source2Viewer render export about 7 min 45 s (peak about 3 GB RAM, 1.1 GB per `.bin`), reduction about 1 to 2 min | `render/tiles`: 63 tiles, **281 MB**, 5.0 M of 30.0 M triangles; `collision/physics.glb` 6.9 MB; `entities.json` 6,076 entities |
| `tile` | 14 s | 126 files (63 LOD0 + 63 LOD1): LOD0 **63.1 MB**, LOD1 **39.8 MB**, total **102.9 MB** (281 MB before: 2.7x smaller), largest tile **4.2 MB**; quantiser skips `TEXCOORD_0` outside [0,1] (harmless: lite has no textures) |
| `bake` (BVH + grid) | 24 s | BVH 5.4 MB (103,174 triangles after dropping `sky` and `Citadel_Skyclip`, 2 nodes skipped), grid **333 x 385 cells of 64** (origin -10368,-12288), 1.1 MB, **109,090 / 128,205 cells (85.1 %) have a floor** |
| `bake` navmesh (M5) | about 3 s | `baked/navmesh.bin` 0.4 MB: 49,504 input triangles, 307 Recast tiles, **9,185 polygons, 821 components, largest only 2.8 %**, 1 stitched edge, **7 links** (3 zipline, 4 jump pad; 13 dropped for being over 256 units from the mesh); QA OBJ at `<bundle>.qa/navmesh.obj` (not run through sign-off) |
| `pack-lite` | under 1 s | **125.0 MB** total (budget 900 MB), 126 tiles, 0 texture files, ok |
| `inspect` | under 1 s | ok; placeholder semantics warning |
| contracts `check:real` | under 1 s | ok (see contracts STATE) |

Disk: the lite bundle is 125 MB published; transient scratch is about 2.8 GB (`.work/render-full`, deleted after `extract` unless `--keep-work`) plus the 1.8 GB of textures the CLI writes if `--materials` is passed. Plan for about 4 GB free for a lite run.
- All 375 entities that have a normalised kind lie inside the baked grid footprint (the sky lid removal shrinks it from the 42,956 x 37,728 collision bounds to 21,312 x 24,640).
- LOD1 keeps about 68 % of LOD0 triangles on the sampled tiles (e.g. 15,728 -> 10,677), not the 25 % `--lod-ratio` asks for: the 2 % error bound stops the simplifier first. Tune before relying on LOD1 for far views.
- **The 85.1 % is not real walkable floor** (see "Collision finding" below).

### Collision finding: `world_physics` does not hold the map's walkable ground (resolved by option 4, see "Walkable surface from the game's nav" below)
`floorHeight` of the 109,090 cells with a floor: **61.6 % at z about 1536, 11.1 % at 2048, 8.9 % at 1792, 6.3 % at 2816, 5.7 % at 2560, 5.2 % at 2304 and only 0.2 % near 256** (the arena floor should be near z 0 to 300). The largest navmesh components are flat surfaces at constant heights (z 2560, 1536, 2468), i.e. the tops of `npcclip` / `playerclip` volumes. Excluding the `playerclip` / `npcclip` layers leaves only **5,994 of 89,598 cells (6.7 %)** with any floor and a 169-polygon navmesh. The exporter is not dropping geometry: the PHYS block really holds 12 mesh shapes that decode to about 100 k triangles, mostly clip volumes (S2 hypothesis confirmed). So with the current collision input, `bake`'s floor, `interior`, `wallDistance` and the navmesh describe the clip lids, not the walkable map; the BVH is still fine for coarse rays against clip/solid volumes.
- The walkable geometry is probably in per-model physics (aggregate `.vmdl_c` files, 1,935 of them) or only in the render meshes. Options to evaluate: (1) export the aggregates' own physics and instance them with the world-node matrices; (2) build the collision soup from the full render export, filtered to opaque materials (30 M triangles, heavy but a one-off); (3) use the game's own `pve_nav_cache.vdata_c` walkable points as seeds and for QA; (4) reverse the `.nav` file. Pick one before M5 sign-off or any query that needs floors.

### Bugs the real data exposed (fixed in this change)
1. **`--gltf_export_materials` breaks the render export.** With it, Source2Viewer 20.0 logs a `VCS file version 72` exception per material, writes 1,533 textures (1.8 GB) and the three `.bin` files, then never writes `n0.gltf` (once it exited without it, once it idled for hours). `extract` then crashed with `ENOENT .../n0.gltf`. The flag is now opt-in (`extract --materials`, off by default); lite does not need it (untextured, PLAN section 5.9).
2. **Lite reduction copied whole vertex buffers.** Aggregate fragments share their mesh's vertex buffer and index a small part of it, so a 1.19 M-triangle selection produced **4.1 GB** of tiles and 1,722 of 2,317 chosen primitives were "over budget" and dropped. `liteRender` now sizes, bounds and emits only the referenced vertices (and reads tightly packed accessors with a fast path): the same 5.0 M triangles are **281 MB**, nothing dropped. Oversize drops are now one summary warning, not one line each.
3. **Guardians were never mapped.** The real `info_super_trooper_spawn` carries `bossname` (e.g. `boss_rebel_t1_blue`), not `subclass_name`; `entityKind` input now takes either. `entities.json` has **6 guardians** (was 0). The test fixture uses the real shape.
4. **Zipline / jump pad link keys were guesses.** Real keys: jump pads use `target` (a `info_target_server_only` landing, all 17 resolve); zipline nodes share `path_uniqueid` and are ordered by `path_index`. Nodes hang in the air, so each path's first and last node become one link (3 paths), and endpoints must be within 256 units of the navmesh (13 of 20 links were dropped on this navmesh, mostly because it does not cover the real ground).
5. **`pack-lite` counted scratch.** `.work/` and `.stage-*` were summed into the 900 MB budget though `publish-data` excludes them; they are now listed as a note and excluded from the total.

## Lite decimation (2026-10-06, extractor 0.4.0)

`buildLiteTiles` (`src/liteRender.ts`) no longer keeps or drops whole primitives. The largest primitives (bbox diagonal) are kept at full detail for `fullFraction` of `--tri-budget` (default 0.6 of 5 M); every other primitive is simplified per primitive with meshoptimizer (`simplify` with `Prune`, falling back to `simplifySloppy` when the error bound blocks the target) by one common ratio that fills the rest of the budget, with a floor of `minTris` (12) triangles per primitive (or all of them if it has fewer). Priority is largest-first when the budget runs out. `--full-fraction 1` restores the old behaviour. New flag `--full-fraction <0..1>`; options `fullFraction`, `minTris`, `decimateError` (0.1 of the primitive's extent) in `LiteOptions`. `liteReady` must be awaited before `buildLiteTiles` (the simplifier is WASM).

Real dl_midtown (build 25738777), default budget 5.0 M triangles:

| | before (whole-primitive cut) | after (decimation) |
|---|---|---|
| primitives kept | 674 of 27,690 (2 %) | **22,505 (81 %)**: 4,422 at full detail, 18,083 decimated from 24.4 M to 2.0 M triangles |
| triangles | 5.0 M | 5.0 M |
| tiles (before `tile`) | 63, 281 MB | 64, 250 MB |
| after `tile` (LOD0 + LOD1) | 126 files, 102.9 MB | 128 files, **87.3 MB**, largest 4.2 MB |
| `pack-lite` total | 125.0 MB | **109.3 MB** (budget 900 MB) |
| reduction time from the cached export | about 1 min | **53 s** (96 s via `extract`, which also redoes entities/collision) |

Full cached rerun: `extract` 96 s + `tile` 24 s + `bake` 50 s (BVH, grid, navmesh) about 3 min; the Source2Viewer export (about 8 min) is only needed once per build when `--keep-work` is used.

Speed: the first decimation took 549 s because every fragment of an aggregate re-read, and meshopt re-processed, the aggregate's whole shared vertex buffer (22,480 distinct simplifications). Now accessor reads are cached (LRU, 384 MB), jobs run grouped by vertex buffer, and each job simplifies only the vertices its indices reference: analysis 63 s -> 3 s, simplification 429 s -> 24 s.

Not verified visually: the triangle selection is by size and a uniform ratio, so thin or detailed small props may look coarse; check the lite tiles in map-viewer next to the collision GLB, then tune `--full-fraction`, `minTris` and the error bound. The budget (5 M) could be raised: tiles are only 87 MB after compression.

## Walkable surface from the game's nav (2026-10-06, module 0.8.0)

Decision (Malcolm): option 4 of "Collision finding", reverse-engineer `maps/<map>.nav`. **Decoded enough to use it**: the file holds the walkable mesh itself, in the entity/world frame, so no Recast and no per-aggregate physics are needed for the floor.

### What the files are (dl_midtown, builds 25738777 and 25761866, byte-identical `.nav`; no public spec, found by inspection and checked against entities)
- `dl_midtown.nav` (10.6 MB): `u32 0xFEEDFACE, u32 version (36), u32 0, u32 0x01000001`, then an **empty binary KV3 v5 block** (`KV3\x05`, uncompressed, 129 bytes, ends `00 DD EE FF`) at 0x10, then `u32 vertexCount` (146,016), `f32 xyz * n` (**Source units, Z up, same frame as `entities.json`**: X -9733..9276, Y -10741..10539, Z -765..2755), `u32 faceCount` (103,780), per face `u8 n (3 or 4), u32 vertexIndex * n, u32 0xFFFFFFFF` (62,688 triangles + 41,092 quads). All indices are valid. After the faces: a second empty KV3 block and a per-face record stream (`u32 faceId` from 1, then flags and small lists, 62 to 82 bytes each) that is **not decoded**; nothing geometric is needed from it.
- **Frame check:** the 6 guardians sit at z 248..256 and the nav is at 242..262 under them; both patrons at z 632 vs nav 647/649; 133 of 168 sampled gameplay entities (spawns, camps, orbs, bosses) lie inside a nav polygon in xy. Typical ground is z 250..400. Several levels exist (z about 387 and about 2499 stacked in places).
- `dl_midtown.navflowmap` (2.8 MB) is a plain **binary KV3 v5, uncompressed**: `{ version, hulls: [ { hull_index, nodes: [ { i, center, nav_ids, connections: [ { cost, node_index, nav_id } ], flow_map } ] } ] }`, 3 hulls (2,549 / 2,690 / 1,900 nodes). `nav_ids` are **1-based face indices**: 102,638 of 103,780 ids lie within 500 units of their node centre, and the ids partition the faces. A node is a connected group of faces (53 of 2,549 hull-0 nodes span more than one shared-edge component). Which hull is the hero hull is **unverified** (hull 0 is the default, `--flow-hull`).
- `dl_midtown.navspace` (55 MB) is not needed and is not copied.
- Source2Viewer-CLI facts: `-f maps/<map>.nav` is a **prefix match** (also `.navspace`, `.navflowmap`), so `-o` becomes a folder with a `maps/` tree; `S2V -i <file.navflowmap> -d` prints the KV3 as text on stdout (not used; `src/kv3.ts` reads the binary directly, ported from VRF's `BinaryKV3`).

### Code
- `src/navFile.ts` (`parseNavFile`), `src/kv3.ts` (`parseKv3`, v5 uncompressed only; compressed, blob and other versions are rejected with a clear error), `src/navFlow.ts` (`parseFlowMap`, `flowLinks`), `src/walkable.ts` (`cleanNavFaces`: weld the pooled vertices (**40,106 of 146,016 repeat a position**), drop repeated faces (**18,295 faces repeat another face's vertex set**), stitch T-junctions (12,491 edges); `triangulate`; `loadWalkable`).
- `extract`: new `nav` stage copies `collision/walkable.nav` and `collision/walkable.navflowmap` into the bundle. A map without a `.nav` only warns. **Fresh end-to-end run on the real game (build 25761866): `extract --tier lite`, `tile`, `bake`, `pack-lite` (all ok) and `inspect` (ok) reproduce the numbers below exactly** (128 tile files 92.0 MB after tiling; the lite render export took about 7 min). Fix found on the way: `extract` now recreates an empty `render/` dir before clearing it (it had vanished during the export and crashed the lite stage with ENOENT).
- `bake`: `floorHeight` is built from the nav faces (`--floor-source auto|game-nav|collision`); `interior` / `wallDistance` still ray-cast the **collision BVH** from that floor. The BVH itself is unchanged. `baked.floorSource` and `baked.walkable` (stats, covered cells, `multiLevelCells`) are raw-only manifest extras.
- `bake` navmesh: `--nav-source auto|game|recast`. `auto` takes the game nav when the bundle has it: polygons = the cleaned faces (convex tri/quads, adjacency by shared edges), links = entity jump pads/ziplines (as before) + hull-0 `.navflowmap` connections whose endpoints are in different shared-edge components (kind `navConnection`, one way, from the source node's face nearest the destination face to the destination face). Recast is the fallback and unchanged. The record keeps the contracts shape (`tiles` 0, `agent`/`recast` zeros = not applicable) plus raw extras `source`, `walkable`, `componentsWithLinks`, `largestComponentShareWithLinks`.
- Tests (`test/nav.test.ts`, 13, synthetic `.nav`/KV3 writers in `test/navFixtures.ts`, no game data): KV3 round trip and rejections, `.nav` parse and rejections, weld/dedupe/T-junction/face-to-polygon, flowmap parse and links, bake floor from nav vs collision, cache re-key, navmesh from nav (island joined by a flow link, path around the wall), fallbacks and error paths, extract nav stage (folder/single/none).

### Real-data result (dl_midtown; parse 0.6 s, bake 17 s)
| | before (clip lids, `world_physics` only) | after (game nav) |
|---|---|---|
| grid cells with a floor | **6.7 %** had a non-clip floor (5,994 of 89,598); with the clip layers in, 85.1 % but 61.6 % of those at z about 1536 (lids) | **47.3 %** (46,930 of 99,234 cells of 64; footprint 19,010 x 21,280, now the playable area) |
| floor height | 61.6 % at z about 1536, 0.2 % near 256 | 47.9 % in z 250..500, 21.3 % in 500..750, 10.8 % in 1000..1250; peak at street level |
| navmesh | 169 polygons (clip layers off) or 9,185 polygons, 821 components, largest 2.8 % (clip layers on) | **85,485 polygons, 1,739 components, largest 74.9 % by shared edges; 92.2 % (927 components) once the 2,455 `navConnection` + 13 jump pad links count**, 2.8 MB |
| entity coverage | 13 of 20 zipline/jump pad links dropped | 277 of 375 kinded entities within 400 units of the mesh (all guardians, walkers, patrons, barracks, camps, shops, trooper spawns, capture points; 22 of 36 healing orbs and 47 of 129 zipline nodes hang in the air); 7 of 20 entity links dropped |
| routes | none meaningful | patron to patron 23,031 units (spawn to spawn 30,382, guardian to guardian 22,816); camps and orbs on other levels need the links (**106 of 115 base/lane/camp entities reachable from patron 0 with links, 81 walking only**) |

- **Multi-level floors:** 8,898 of 46,930 floor cells (19 %) have walkable surfaces on more than one level (z gap above 48). `floorHeight` is one value per cell (spatial-core's topmost surface), so those cells report the upper level; the navmesh keeps all levels. A multi-layer grid (or a walkable-level selector) is a spatial-core / contracts decision.
- **`interior` is still not meaningful (80.8 % of floor cells) and cannot be fixed from `world_physics`:** its playerclip/npcclip lids sit within 1500 above street level. Without the clip layers it is 3.3 % (0.0 % without foliage too), because real buildings are not in `world_physics` at all. It needs the `citadel_trigger_interior` volumes (22 entities, per-entity models not exported yet) or render geometry. `wallDistance` finds a clip/solid wall within range for 79 % of cells; also provisional (placeholder semantics).
- Not decoded: per-face records (nav flags, one-way/ledge info), the meaning of the other two hulls, `.navspace`. **Not verified:** that all 85,485 polygons are walkable for the hero hull (the file may be the union over hulls); `navConnection` directions and costs are taken from the flowmap as is (link cost is distance / speed of the kind; the flowmap's own cost is ignored).

## In progress
- Nothing running; navmesh signed off (see above).

## `tile` after a cached `extract` (2026-10-07)
- `extract` always rewrites `manifest.json` from scratch (tile entries of the lite stage, no LODs, no `baked`), even when its render stage is cached. After the first tiled run the files in `render/tiles` are meshopt-compressed, so a following `extract` (for example the cheap `nav` stage) left a manifest with stale hashes over compressed files, and `tile` died with `[EXT_meshopt_compression] Please install extension dependency, "meshopt.decoder"`. `tile` now registers the meshopt decoder, so the sequence `extract`, `tile`, `bake` works on any rerun (LODs are re-simplified from the decoded LOD0, which is quantised to 14 bits already). Test: tile, reset the manifest, tile again; ids, hashes and triangle counts hold. Found while writing the publish/update runbook (`docs/dev-site.md`).

## Next
1. **Hull and M6:** the navmesh is signed off (see "Navmesh sign-off"); decide the hull (`--flow-hull`) if a query shows a hull-specific problem. Then M6 (caching/resume/`diff`, README, update runbook). To get `walkable.nav` into an existing bundle, re-run `extract` (only the cheap `nav` stage runs; `EXTRACTOR_VERSION` did not change), which rewrites the manifest, so then `tile` and `bake --force` (full sequence in `docs/dev-site.md`).
2. **`interior`** needs other data: export the `citadel_trigger_interior` models (open question c) or derive it from render geometry; `world_physics` cannot supply it (see the game-nav section).
3. Triangle cut quality (open question d): decimation is in (see above). Look at the lite tiles in map-viewer next to the collision GLB and tune `--tri-budget` (the bundle is only 109 MB, so there is room to raise it a lot), `--full-fraction` and `minTris`. Check `tile` LOD1 ratio at the same time.
4. Open questions: (a) physics vs render frame **settled, same frame** (see M1 findings); (b) all hulls exported and (c) per-entity volume models (interior/trigger shapes) still open.
5. Check `dl_hideout` / `new_player_basics` only if the owner wants them (not in Slice 1).

## Blockers / Requests to other modules
- spatial-core: (a) export a `SEMANTICS_VERSION` (bake currently hashes `semantics/*.ts` at run time); (b) `floorHeight` is the topmost surface, so interior cells under a roof are not detected, and row-range/worker-friendly `SampleGrid.build` would let `bake` parallelise.
- contracts: `manifest.baked` is `Record<string, unknown>`; bake writes the shape documented under M4. Contracts M3 (baked-data specs) should adopt it (or tell us what to change), including `semanticsVersion` and `placeholder`.
- contracts: `Tile` has no `lod` (or `lods[]`) field, so LODs are encoded as separate tiles with id `<id>#lod<n>` and a shared `bounds` (see M3). A `Tile.lod` / `Tile.lodOf` field would let the viewer select LODs without parsing ids; map-viewer M4 should read this convention until then.
- contracts: `manifest.baked.navmesh` shape is documented under M5; the navmesh binary is spatial-core's `NavMesh.serialize()` layout (contracts has no spec yet). Contracts M3 (baked-data specs) should adopt it.
- root (optional): add `data/` to `.gitignore`; the extractor already self-ignores its output root.
- contracts: `Tile` has a single `file`; the render export is `n0.gltf` + 3 `.bin` (>1 GB each). Tile `bytes` currently sums the bins and `sha256` covers the `.gltf` only. Consider `Tile.files[]` or a size-limit/tiling note (M3).
- contracts (from the game-nav bake, 0.8.0): `BakedNavmesh` requires `agent`, `recast`, `excludedLayers`, `inputTriangles`, `tiles`, which mean nothing for a navmesh taken from the game's own faces (written as zeros / empty). Please make them optional and add `source: "game-nav" | "recast"`, `componentsWithLinks`, `largestComponentShareWithLinks`; `Baked` gains `floorSource` and `walkable` (the extractor already writes them as raw extras); `CollisionRef` could name `walkableNav` / `walkableFlowmap` (now found by the fixed paths `collision/walkable.nav` and `.navflowmap`).
- spatial-core / query-builder: game-nav links have kind `navConnection` (about 2,455, one way); `MovementModel.linkSpeeds` must list it or those links are unusable (without them 34 of 115 base/lane/camp entities are not reachable from a patron on foot). `floorHeight` is the topmost walkable surface: 19 % of floor cells have a second level, so a multi-layer grid (or a level selector) is wanted. `interior` cannot come from `world_physics` (see the game-nav section).

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

- 2026-10-06 - Real run: world_physics lacks walkable ground (floors are clip lids), recorded as a finding rather than worked around; zipline links are first-to-last node per path, jump pads follow `target`; `--gltf_export_materials` is opt-in because it hangs the real export; lite tile reduction emits only referenced vertices; guardian marker is read from `bossname` as well as `subclass_name`; `pack-lite` size excludes scratch.

- 2026-10-06 - Lite decimation: per-primitive meshopt simplification with a common ratio for everything outside the largest-primitive full-detail share (default 0.6 of the budget), a per-primitive triangle floor, cached accessor reads and vertex compaction for speed; `EXTRACTOR_VERSION` bumped to 0.4.0 so old lite stages rebuild.
- 2026-10-06 — Flaky `verify:all` fix: the five tests that run a real bake or navmesh bake (0.5 to 1.3 s alone) get an explicit 60 s timeout. bun's 5 s default failed them in clean-clone runs where `verify:all` ran every module in parallel on a busy machine. Assertions unchanged; the timeout only guards against a hang.

- 2026-10-06 — Walkable surface: use the game's own `.nav` (Malcolm chose reverse engineering). Only the geometry is decoded (vertex pool + faces); the `.navflowmap` is read as binary KV3 (own reader, no text round trip through the CLI); `walkable.nav` / `.navflowmap` live in `collision/` of the bundle at fixed paths; `bake` and the navmesh stage switch to them automatically (`auto`) and keep the old collision/Recast path as the fallback and via flags; the navmesh record keeps the contracts shape (zeros for Recast-only fields) and carries raw extras until contracts adopts them; `EXTRACTOR_VERSION` stays 0.4.0 so the render stages stay cached; `interior` is left on the collision BVH and flagged, not faked.
- 2026-10-07 — Lanes are exactly **Yellow (1), Blue (2, the middle lane) and Green (3)**; the game's own data calls Green "purple" (`boss_*_t1_purple`, `*_t2_boss_purple`, a (139,0,139) zipline tint), which is read as Green, so no "purple" lane exists downstream. The real dl_midtown entities carry no `lanenum`/`teamnumber`, so `toEntities` derives `lane` from the colour in `bossname` / `subclass_name` / `targetname` of guardians, walkers, barracks and base sentries, and gives zipline nodes the lane of their path (`citadel_zipline_path` `color_tint` by hue: orange Yellow, blue Blue, magenta Green; skipped when `use_baselane_color` is set or the path is untinted). An explicit `lanenum` always wins. Checked against the real bundle's entities: Yellow sits at -x, Blue at x ~ 0, Green at +x for all 6 guardians, 6 walkers, 12 barracks and all 129 zipline nodes. `team` was not derived then; see "Team from names" below. Multi-line quoted values (`pathnodes "` ... `]"`) are now one value (a flat number list) instead of one junk property per line (`"0.0,"`, with later lines overwriting earlier ones); the 9-floats-per-node layout is still unverified, so a real re-extract should be checked (`pathnodes` is an array of numbers, no key ends with a comma).

## Open questions
- (see PLAN.md §9, and "Next" item 2 above)
