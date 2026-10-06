# dlq-shoot

Local-only command line tool that drives a **running Deadlock client** through its console to move the camera to a list of poses and take screenshots. The result is a `ScreenshotSet` (`index.json` + images + thumbnails) that the map viewer shows as street-view style reference imagery and that can serve as ground truth when checking visibility and interior queries.

## Safe use

- **Offline / sandbox sessions only.** Never run this against matchmaking or any online match. `shoot` refuses to drive the real game unless you pass `--offline`, which is your statement that the game is in an offline sandbox session. The tool cannot check this itself yet.
- It only sends **console commands** over the console port you opened with a launch option (`setpos`, `setang`, `getpos`, `screenshot`, a few display settings). It does **not** read or write game memory, inject code, press keys or touch anti-cheat.
- Use at your own risk and check the game's current terms of service. Camera commands may be cheat-gated; the tool does not work around that, you enable them in your own offline session.
- Screenshots are Valve content. The output folder is git-ignored; do not publish it.

## Quick start (no game needed)

```sh
bun run dlq-shoot plan ring --map dl_midtown --build 1 --at 0,0,100 --resolution 640x360 --out /tmp/plan.json
bun run dlq-shoot shoot /tmp/plan.json --fake --out /tmp/set
bun run dlq-shoot verify /tmp/set
```

`--fake` uses an in-memory game that writes placeholder images; the set is marked `placeholder: true`. This is what the tests and CI use.

## With the real game

> Status: the transport, launch options and some commands are **unverified** (spike S3 needs a real session). See `STATE.md` for what has been confirmed. The values below are the current best guess.

1. Start Deadlock **offline** with the launch options `doctor` prints, e.g. `-netconport 2121 -windowed -novid -insecure`.
2. `bun run dlq-shoot doctor --game-dir "<Deadlock install>"` checks the game process, console, and screenshot folder.
3. `bun run dlq-shoot console "echo hi"` should print `hi`.
4. Make a plan and run it:

```sh
bun run dlq-shoot plan grid --bundle data/bundles/dl_midtown --spacing 1500 --z 200 --yaws 4 --out plan.json
bun run dlq-shoot shoot plan.json --offline --game-dir "<Deadlock install>"
bun run dlq-shoot verify data/screenshots/<gameBuildId>
```

If the run stops (crash, Ctrl-C, game exit), restart the game with the same launch options and add `--resume`: shots already taken are kept.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Game process, console reachability, screenshot folder, launch options |
| `console ["<cmd>"]` | Send one console command (or commands from stdin) and print the reply |
| `plan grid` / `ring` / `from-file` | Make or validate a shot plan |
| `plan from-annotations` / `from-metadata` | Cameras around annotation points / accepted creep camps, Sinner's Sacrifice, healing orbs; with `--bundle` they respect the map bounds and (baked bundle) lines of sight |
| `shoot <plan.json>` | Run a plan: pose each shot, verify the pose, capture, pick up the file, thumbnail, index. `--resume`, `--force`, `--attempts`, `--json` |
| `verify <set-dir>` | Check a finished set: index, files, sha256, pixel size, poses, build id |
| `thumbs <set-dir>` | Make missing thumbnails and record them in the index |

Run any command without arguments for its options. Add `--fake` to `doctor`, `console` and `shoot` for the in-memory game.

**Exit codes** (stable): `0` ok, `1` usage error, `2` the command ran and found a problem (a failed check, a shot that could not be taken, an invalid plan).

## Output

`data/screenshots/<gameBuildId>/` (override with `--out`):

```
index.json     ScreenshotSet (contracts): poses requested and read back, hashes, sizes, timestamps
index.jsonl    append-only log written while the run goes (used by --resume)
<id>.jpg|png   the screenshots
thumbs/<id>.jpg  320 px JPEG thumbnails
```

A shot plan (`plan.json`) lists `{ id, position, angles | lookAt, group? }` per shot in world space (Source units, Z-up; angles are `setang` order pitch, yaw, roll in degrees). Plans contain no results, so one plan can be re-run on another game build.

## Limits

- Pose verification relies on the `getpos` reply format (`setpos x y z;setang p y r`); if it cannot be parsed the shot is taken with a warning and no read-back pose.
- Only PNG and JPEG screenshots are read (set the game's screenshot format accordingly).
- Lines of sight in `plan from-*` come from the baked collision; until the extractor produces walkable collision they are not trustworthy on the real map.
