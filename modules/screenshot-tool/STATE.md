# screenshot-tool — state

- **Status:** M0 built against the fake console; real-game acceptance pending (Malcolm)
- **Version:** 0.1.0
- **Current milestone:** M0 (see PLAN.md §6)
- **Last updated:** 2026-10-06

## Done
- M0 scaffold: workspace package `@deadlock-query/screenshot-tool`, CLI `dlq-shoot` (`bun run dlq-shoot ...`), stable exit codes (0 ok, 1 usage, 2 problem).
- `GameConsole` Effect service (`src/console.ts`) with `send(command)`; tagged `ConsoleError` (`connect` / `timeout` / `closed` / `rejected`) that always carries a remediation string.
- `NetConPort` implementation: line-based TCP, one connection per command, reply = data until the stream is quiet (`settleMs`). Tested against a local TCP server (reply, refused, timeout, closed without reply).
- Fake implementation (`src/fake.ts`, `makeFakeGame`): `echo`, `setpos`, `setang`, `getpos`, `screenshot`, unknown-command reply, plus options for cheat-gated commands, pose drift and reply delay. `--fake` on the CLI uses it.
- `doctor`: game process, console probe (`echo dlq-doctor`), screenshot folder, launch options; offline/sandbox mode is reported as "not verified" until S3 finds a readable signal.
- `console ["<cmd>"]`: one-shot passthrough, or reads commands from stdin.
- 10 tests (`bun run verify`): fake console, NetConPort, doctor, CLI.

## In progress
- (nothing)

## Next
- **Malcolm-only, needs the game:** M0 acceptance and spike S3. Start Deadlock offline with `-netconport 2121` (the launch options in `doctor` are guesses), then `bun run dlq-shoot doctor --game-dir <Deadlock install>` and `bun run dlq-shoot console "echo hi"`. Record in this file: which transport works (NetConPort vs RCON), exact launch options, whether `setpos`/`setang`/`getpos`/`screenshot`/`noclip`/`cl_drawhud` exist and are cheat-gated, the real screenshot folder, and whether the reply framing matches `netConSend`. If the game uses RCON instead, add a `SourceRcon` layer next to `NetConPort`.
- M1 (`plan grid/ring/from-file`) needs the contracts `ScreenshotSet` type (M4 in contracts, see Requests).

## Blockers / Requests to other modules
- contracts: `ScreenshotSet` is not defined yet (contracts M4). Needed from M1/M2 on.
- infra (small `[infra]` PR): add `data/screenshots/` to `.gitignore` (PLAN.md §2 wants output git-ignored); this module cannot touch root files.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-06 — M0: `NetConPort` is the first real transport because `-netconport` is what D12 names; RCON is added only if S3 shows Deadlock needs it. Default console port 2121 is arbitrary (override `--port` / `DLQ_CONSOLE_PORT`). `doctor` takes the screenshot folder from `--screenshot-dir` or `<game-dir>/game/citadel/screenshots` **[VERIFY]**.

## Open questions
- (see PLAN.md §9; transport, command availability and screenshot folder await S3)
