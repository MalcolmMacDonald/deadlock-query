# screenshot-tool — state

- **Status:** M0 to M3 done against the fake console; real-game checks pending (Malcolm)
- **Version:** 0.4.0
- **Current milestone:** M4 next (see PLAN.md §6)
- **Last updated:** 2026-10-06

## Done
- M0 scaffold: workspace package `@deadlock-query/screenshot-tool`, CLI `dlq-shoot` (`bun run dlq-shoot ...`), stable exit codes (0 ok, 1 usage, 2 problem).
- `GameConsole` Effect service (`src/console.ts`) with `send(command)`; tagged `ConsoleError` (`connect` / `timeout` / `closed` / `rejected`) that always carries a remediation string.
- `NetConPort` implementation: line-based TCP, one connection per command, reply = data until the stream is quiet (`settleMs`). Tested against a local TCP server (reply, refused, timeout, closed without reply).
- Fake implementation (`src/fake.ts`, `makeFakeGame`): `echo`, `setpos`, `setang`, `getpos`, `screenshot`, unknown-command reply, plus options for cheat-gated commands, pose drift and reply delay. `--fake` on the CLI uses it.
- `doctor`: game process, console probe (`echo dlq-doctor`), screenshot folder, launch options; offline/sandbox mode is reported as "not verified" until S3 finds a readable signal.
- `console ["<cmd>"]`: one-shot passthrough, or reads commands from stdin.
- 10 tests (`bun run verify`): fake console, NetConPort, doctor, CLI.

- M1 `plan` (`src/plan.ts`, `src/planCli.ts`): `grid` (cell centres over xy bounds, centred lattice, N yaws per cell, fixed camera z), `ring` (N yaws, default 8, at each `--at x,y,z`), `from-file` (validate and rewrite canonically). Shot plan = Effect Schema `ShotPlan` (`schemaVersion`, `map`, `gameBuildId?`, `resolution`, `fov`, `hideHud`, `shots[{id, position, angles | lookAt, group?}]`); `parsePlan` reports every problem (exactly one of angles/lookAt, unique ids, filesystem-safe ids, no empty plan). Output is byte-for-byte deterministic (stable ids like `grid-r001c002-y090`, 3-decimal rounding, canonical key order). `lookAtAngles` gives Source angles (positive pitch looks down) for M2. `--bundle <dir>` takes map, build id and xy bounds from `manifest.json`. Hard cap of 5000 shots per plan. 20 tests.

- M2 `shoot` (`src/shoot.ts`, `src/shootCli.ts`, `src/image.ts`): `dlq-shoot shoot <plan.json> [--fake|--offline] [--screenshot-dir|--game-dir] [--out] [--build] [--force] [--settle-ms] [--timeout-ms]`. Session setup once (`fov_desired`, `cl_drawhud`), then per shot `setpos`, `setang`, `getpos` read-back verified against the requested pose (contracts `poseError`, default 8 units / 1 degree), settle wait, `screenshot`, pickup of the new file from the game's screenshot folder, move to `<out>/<id>.<ext>`, append to `index.jsonl`; finally `index.json` is a validated contracts `ScreenshotSet` (`placeholder: true` with `--fake`, `tool` set). Image size, bytes and sha256 come from the file (PNG/JPEG headers parsed). Stops at the first failure with a tagged `ShootError` (`setup` / `pose` / `pickup` / `image` / `output`) carrying a fix hint. Output defaults to `<repo>/data/screenshots/<gameBuildId>/`; an existing run is refused without `--force`. The fake game now writes placeholder PNGs into its screenshot folder (optional delay / drop for tests). 33 tests.

- M3 robustness (`src/shoot.ts`, `src/shootCli.ts`): `--resume` keeps the shots already in `index.jsonl` (checked against the plan's poses and the files on disk; a half-written last line or a missing file means that shot is taken again; a changed plan is an error pointing at `--force`) and skips session setup when nothing is left. Per-shot retry (`--attempts`, default 3, `--retry-delay-ms`) for pose not honoured, no screenshot file, console timeout and a briefly unreachable game; refused commands, bad images and output problems are not retried. Per-attempt time limit (60 s). Crash detection: when the console is unreachable and the Deadlock process is gone (`gameRunning`, real runs only) the run stops at once with "restart the game, re-run with --resume"; if the process is still there it is retried first. Progress: `onProgress` callback, `shootEvents` (an Effect `Stream` of `ShootProgress`), and `--json` for one JSON event per line on stdout. The fake game can crash/restart and drop or drift the first N screenshots/poses. 43 tests.

## In progress
- (nothing)

## Next
- **Malcolm-only, needs the game:** M0 acceptance and spike S3. Start Deadlock offline with `-netconport 2121` (the launch options in `doctor` are guesses), then `bun run dlq-shoot doctor --game-dir <Deadlock install>` and `bun run dlq-shoot console "echo hi"`. Record in this file: which transport works (NetConPort vs RCON), exact launch options, whether `setpos`/`setang`/`getpos`/`screenshot`/`noclip`/`cl_drawhud` exist and are cheat-gated, the real screenshot folder, and whether the reply framing matches `netConSend`. If the game uses RCON instead, add a `SourceRcon` layer next to `NetConPort`.
- M4: `from-annotations` / `from-metadata` generators with line-of-sight check (contracts `Annotation`; LOS needs the baked collision, so the LOS part waits on real walkable data, the framing/standoff part can be built against the contracts fixtures).
- **Malcolm-only, M3 acceptance:** kill the game mid-run, restart it with the same launch options and re-run with `--resume`; it should finish the set. Check that the `deadlock` process name used by crash detection matches Task Manager (`doctor` uses the same list).
- **Malcolm-only, M2 acceptance (20-shot real run):** besides the M0 steps, check and record: the real `getpos` reply (the parser accepts `setpos x y z;setang p y r`, the `_exact` variants and extra lines; if it fails, shots are taken with a warning and no `actual` pose), whether `fov_desired` and `cl_drawhud` exist (setup fails loudly on "Unknown command", fix the list in `sessionSetup`), the screenshot folder and file format (PNG/JPEG only; TGA etc. fail with `image`), the settle time needed after `setpos` (default 500 ms; PLAN's double-capture hash-stability check is not built yet), and whether the game's resolution matches the plan (a mismatch is a warning). Run: `bun run dlq-shoot plan ring --map dl_midtown --build <id> --at x,y,z`, then `shoot plan.json --offline --game-dir <install>`.
- Deferred from M1, needs real data: `grid` places every camera at one fixed `--z`. The PLAN wants "height above the walkable surface" from the baked sample grid/navmesh; that needs `spatial-core` in `module.json` `dependsOn` and a real bake (floor currently describes clip lids, see map-extractor STATE.md), so it waits for the walkable-collision work.

## Blockers / Requests to other modules
- (none; `ScreenshotSet` landed in contracts PR #101)
- infra: add `data/screenshots/` to `.gitignore` (PLAN.md §2); handled by the infra thread.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0: `NetConPort` is the first real transport because `-netconport` is what D12 names; RCON is added only if S3 shows Deadlock needs it. Default console port 2121 is arbitrary (override `--port` / `DLQ_CONSOLE_PORT`). `doctor` takes the screenshot folder from `--screenshot-dir` or `<game-dir>/game/citadel/screenshots` **[VERIFY]**.
- 2026-10-06 — M1: `grid` takes an absolute `--z` for now (see Next). Ring is "N yaws on the spot at each `--at`" (default 8). Yaw 0 is +X, increasing counter-clockwise seen from above (Source convention). Plans never contain results, so a plan can be re-run on another build; `--build` or the bundle's build id is only recorded.
- 2026-10-06 — M2: file pickup polls the screenshot folder (new or re-written image, size stable across two polls) instead of `fs.watch`, because watching is unreliable on Windows shares and polling is trivial to test. The first failing shot stops the run (retry is M3). The real game needs `--offline` (the tool cannot confirm sandbox mode from the console yet); the fake does not.
- 2026-10-06 — M1: `from-annotations` / `from-metadata` stay M4; `from-file` only validates and canonicalises.
- 2026-10-06 — M3: retries only cover failures a second attempt can plausibly fix; everything else stops the run so a wrong setup is not repeated 3x per shot. `--resume` refuses a plan whose poses differ from the recorded ones instead of silently mixing sets. `--resume` and `--force` are mutually exclusive.

## Open questions
- (see PLAN.md §9; transport, command availability and screenshot folder await S3)
