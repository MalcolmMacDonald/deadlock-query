# screenshot-tool — state

- **Status:** M0 and M1 done against the fake console; real-game checks pending (Malcolm)
- **Version:** 0.2.0
- **Current milestone:** M2 next (see PLAN.md §6)
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

## In progress
- (nothing)

## Next
- **Malcolm-only, needs the game:** M0 acceptance and spike S3. Start Deadlock offline with `-netconport 2121` (the launch options in `doctor` are guesses), then `bun run dlq-shoot doctor --game-dir <Deadlock install>` and `bun run dlq-shoot console "echo hi"`. Record in this file: which transport works (NetConPort vs RCON), exact launch options, whether `setpos`/`setang`/`getpos`/`screenshot`/`noclip`/`cl_drawhud` exist and are cheat-gated, the real screenshot folder, and whether the reply framing matches `netConSend`. If the game uses RCON instead, add a `SourceRcon` layer next to `NetConPort`.
- M2 `shoot` core loop (pose verification, file pickup, index; output is the contracts `ScreenshotSet`, `makeScreenshotSet`). Everything except the 20-shot real run can be built and tested against the fake console (`--fake` writes placeholder images, `placeholder: true`).
- Needs the real game (Malcolm): the exact `setpos`/`setang`/`getpos` reply format (the fake guesses `setpos x y z;setang p y r`), where the game writes screenshots and how they are named, the settle-wait needed after `setpos`, and the 20-shot acceptance run.
- Deferred from M1, needs real data: `grid` places every camera at one fixed `--z`. The PLAN wants "height above the walkable surface" from the baked sample grid/navmesh; that needs `spatial-core` in `module.json` `dependsOn` and a real bake (floor currently describes clip lids, see map-extractor STATE.md), so it waits for the walkable-collision work.

## Blockers / Requests to other modules
- (none; `ScreenshotSet` landed in contracts PR #101)
- infra: add `data/screenshots/` to `.gitignore` (PLAN.md §2); handled by the infra thread.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0: `NetConPort` is the first real transport because `-netconport` is what D12 names; RCON is added only if S3 shows Deadlock needs it. Default console port 2121 is arbitrary (override `--port` / `DLQ_CONSOLE_PORT`). `doctor` takes the screenshot folder from `--screenshot-dir` or `<game-dir>/game/citadel/screenshots` **[VERIFY]**.
- 2026-10-06 — M1: `grid` takes an absolute `--z` for now (see Next). Ring is "N yaws on the spot at each `--at`" (default 8). Yaw 0 is +X, increasing counter-clockwise seen from above (Source convention). Plans never contain results, so a plan can be re-run on another build; `--build` or the bundle's build id is only recorded.
- 2026-10-06 — M1: `from-annotations` / `from-metadata` stay M4; `from-file` only validates and canonicalises.

## Open questions
- (see PLAN.md §9; transport, command availability and screenshot folder await S3)
