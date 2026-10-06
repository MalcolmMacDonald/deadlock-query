# screenshot-tool — plan

## 1. Purpose & scope
Local-only CLI (`dlq-shoot`) that instructs a running Deadlock client, through its remote console, to move the camera to a list of poses and take screenshots, then collects them into a **ScreenshotSet** (contracts). Screenshots give map-viewer street-view-style reference imagery at annotation points and can serve as ground truth when checking visibility/interior queries.

**Non-goals:** no image processing beyond renaming/thumbnailing; no use in matchmaking/online play; no automation of anything except the camera/screenshot console commands.

## 2. Ownership boundary
`modules/screenshot-tool/**`. Output: `data/screenshots/<gameBuildId>/` (`index.json` + images + thumbnails), git-ignored by default.

## 3. Published surface
| Command | Purpose |
|---|---|
| `doctor` | Detect game process, console availability, screenshot dir; print launch-option advice **[VERIFY]** |
| `launch` | Start Deadlock with required launch options (offline/sandbox, windowed, fixed resolution, console port) |
| `console` | Interactive/one-shot console command passthrough (debug) |
| `plan <generator> ...` | Produce a **shot plan** JSON (`grid`, `ring`, `from-annotations <file>`, `from-metadata <file>`, `from-file`) |
| `shoot <plan.json> [--resume] [--out dir]` | Execute a plan → `ScreenshotSet` |
| `verify <set-dir>` | Check files exist, poses match, build id matches |

Shot plan: `{ gameBuildId?, map, resolution, fov, hideHud, shots[]: { id, position, orientation | lookAt, group? } }`. Output format = contracts `ScreenshotSet`.

## 4. Uses
`contracts`: `ScreenshotSet`, `Annotation` (read annotation files for `from-annotations`), `MapBundle` (bounds + baked navmesh/height grid for `grid`, to avoid shooting inside walls). `spatial-core` (optional): `Raycaster.occluded` over the baked collision BVH for the line-of-sight check of `from-annotations`/`from-metadata` when a baked bundle is given.

## 5. Technical design
- **Transport abstraction** `GameConsole` (Effect service): `send(cmd): Effect<string, ConsoleError>`, plus implementations — `NetConPort` (TCP to the port opened by a `-netconport <port>` launch option, as in other Source 2 titles) and `SourceRcon` (RCON protocol over TCP, password). Choice made by spike S3 **[VERIFY** which Deadlock supports; and whether `getpos`/`setpos`/`setang`/`screenshot`/`noclip`/`cl_drawhud` are available and cheat-gated**]**. Do not rely on synthetic key presses.
- **Session setup** (once): load private sandbox/hideout/offline map (**never** matchmaking; the tool refuses unless `doctor` confirms offline/sandbox mode), enable cheats where needed, free camera/noclip, hide HUD and viewmodel, set fixed FOV/resolution, disable motion blur/bloom variability, freeze time (`host_timescale`/pause) **[VERIFY]**.
- **Per shot**: `setpos`/`setang` → readback with `getpos` and compare (tolerance) → wait for world streaming/LOD settle (poll a deterministic signal if available, else configurable delay + double-capture hash-stability check) → `screenshot` → watch the game's screenshot folder (`@effect/platform` FileSystem `watch`) for the new file → move/rename to `<id>.jpg`, create thumbnail → append to index.
- **Resumable**: index is append-only JSONL during the run and finalized to `index.json`; `--resume` skips done ids.
- **Robustness**: per-shot timeout + retry (3×), detect game exit/crash, backpressure on console, structured progress `Stream`, dry-run mode with a fake console that writes placeholder images (used by tests and CI).
- **Plan generators**: `grid` (spacing, height above walkable surface, N yaw directions), `ring` (8 yaws → panorama-ready), `from-annotations` (look at each point from 3 standoff positions with LOS check via collision, if bundle provided).
- Windows primary (window focus not required if console is over TCP).

## 6. Milestones
**Phasing:** Phase 3 (after Slice 1 and spatial queries). Spike S3 may be run earlier by a free agent since it is independent; the `grid` generator should reuse the extractor's baked height grid/navmesh rather than user metadata.

| # | Deliverable | Acceptance |
|---|---|---|
| S3 (spike) | Prove transport + commands + pose readback + screenshot file capture manually and via a 50-line script | Written go/no-go and exact launch options in `STATE.md` |
| M0 | Scaffold CLI, `GameConsole` + chosen impl + fake impl, `doctor` | Fake-console tests green; `console "echo hi"` works against real game |
| M1 | `plan grid/ring/from-file` | Plans validate; deterministic output |
| M2 | `shoot` core loop with pose verification + file pickup + index | 20-shot run on real game produces valid `ScreenshotSet` |
| M3 | Resume, retry, crash detection, progress output | Kill game mid-run, restart, `--resume` completes |
| M4 | `from-annotations`/`from-metadata` generators with LOS check | Shots frame their target (visual spot-check documented) |
| M5 | `verify`, thumbnails, README with safe-use warning | `verify` flags tampered/missing images |

## 7. Test strategy
Unit tests for plan generators and index writing; fake `GameConsole` simulation (including delays, dropped frames, wrong pose) for the loop; opt-in live test when `DEADLOCK_RUNNING=1`.

## 8. Standalone mode
`dlq-shoot shoot plan.json --fake` produces a full valid `ScreenshotSet` with placeholder images — viewer agent can use the same output; also contracts fixture is generated from it.

## 9. Risks & open questions
- Deadlock may not expose a usable console port or may gate camera commands → fallbacks: demo/replay spectator camera (`demo_*` commands), or Source2Viewer-style offline render of the map (change of scope; raise with human).
- Terms of service / anti-cheat: restrict to offline sandbox, document it, no memory access or injection.
- Rendering nondeterminism (LOD pop-in, TAA) → settle-wait strategy.
- Time-of-day/lighting consistency across shots.

## 10. Definition of done
A documented, reproducible run captures a grid over a section of the map with correct pose metadata; output consumed by map-viewer without modification; resumable; safe-use guard in place; `STATE.md` records exact launch options for the current game build.
