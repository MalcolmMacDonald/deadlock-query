# map-extractor — state

- **Status:** S2 spike complete — **GO** (render, collision, entities, nav all obtainable)
- **Version:** 0.1.0
- **Current milestone:** M1 code done (unit-tested with a fake S2V runner); real-install run pending
- **Last updated:** 2026-10-05

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

## M1 real-run findings (2026-10-05, PR #32, this machine, build 25712201)
- `doctor`: passes after a fix. The CLI reports `20.0.6980+<sha>` and the pin was `20.0`, so `matchesPin` failed; it now accepts `20.0.x`.
- **lite extract** of dl_midtown: 6 s. Bundle is 36 MB on disk (8.7 MB `entities.json`, 6.9 MB `collision/physics.glb`, 21 MB `.work` scratch that can be deleted). `inspect` passes: 6,075 entities (369 with a mapped kind), collision bounds in Source units X -17356..25600, Y -16384..21344, Z -1620..13824 overlap entity bounds.
- **full extract: failed here, out of disk.** The `n0.gltf` export writes 3 bins (about 1.07 + 1.07 + 0.75 GB) and died with `IOException: not enough space` on the second bin; C: had only 7-9 GB free and shrinking. Nothing was published or uploaded. Rerun on a drive with 15+ GB free (S2 measured ~7 min and ~6 GB RAM). The CLI surfaces this as `export failed at render: expected output missing`; the real cause (the first `Exception` line) should be shown instead (follow-up).
- **Frame question settled (physics vs render): same frame.** Physics nodes carry a 0.0254 scale + axis permutation matrix: loaded = (y, z, x) * 0.0254, i.e. metres, glTF Y-up. A render aggregate (`n0_lr0_agg_merge_hideout_vertex_color_3.vmdl_c`, 179 MB glb, 1.10 M tris) has an identity node matrix and raw extents of about +/-290 m, which is metres. Physics loaded bounds [-416,-41,-441]..[542,351,650] sit inside the earlier n0 render bounds [-512,-92,-904]..[799,367,837]. So render is in the same metres/Y-up frame but with identity node matrices. Bug fixed: `extract` previously gave render `glbToWorld` = identity (wrongly "Source units"); it now reuses the physics file's matrix.
- Open: hull completeness (b), per-entity volume models (c), triangle cut for `lite` (d) are unchanged.

## In progress
- Real-install run on the dev machine (see "Next" 1).

## Next
1. Run `doctor` on the dev machine and fix `parseVersion` if needed; optionally wire `doctor --fix` download.
2. M1 open questions to settle first: (a) are physics GLB and render glTF in the same coordinate frame (compare bboxes after applying node matrices); (b) are all hulls exported; (c) per-entity volume models (interior/trigger) export; (d) how to cut render triangles (29.4 M) for `lite`: filter by material name, `--gltf_mesh_list`, instancing; (e) parse the `.vents` text format (specified above).
3. Check `dl_hideout` / `new_player_basics` only if the owner wants them (not in Slice 1).

## Blockers / Requests to other modules
- root: add `data/` to `.gitignore` (bundles are written to `data/bundles/`; not ignored today).
- contracts: `Tile` has a single `file`; the render export is `n0.gltf` + 3 `.bin` (>1 GB each). Tile `bytes` currently sums the bins and `sha256` covers the `.gltf` only. Consider `Tile.files[]` or a size-limit/tiling note (M3).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-05 — Branch is `main`; bake calls spatial-core semantics (placeholder-aware).
- 2026-10-05 — S2: main map is `dl_midtown` (not `dl_*` generic); Source2Viewer-CLI 20.0 pinned as the first tested version; render export must be `.gltf` (+bins), not `.glb`, because of the 2 GiB limit.

- 2026-10-05 — M0: no `@effect/cli` yet (two commands); hand-rolled parser, swap when `extract` flags grow. Tool path via `S2V_CLI` or `~/tools/s2v`.

- 2026-10-06 — M1: lite tier omits render geometry for now (collision + entities only) rather than guess a decimation; full tier exports `n0.vwnod_c` as `.gltf`. Hand-rolled argv kept.

## Open questions
- (see PLAN.md §9, and "Next" item 2 above)
