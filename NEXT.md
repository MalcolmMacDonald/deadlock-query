# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M3 data release flow; M4 Cloudflare dev site | M3: a bundle from S2. M4: secrets in `docs/secrets.md` |
| contracts | M1 MapBundle/QueryResult/fixtures | S2 findings (human, local) |
| map-extractor | S2 spike: run Source2Viewer on the game, record what exists in STATE.md | Human: game install (see below) |
| query-builder | S1 spike: Monaco TS worker + custom `.d.ts` + sandboxed run/cancel | none |
| spatial-core | S5 spike: three-mesh-bvh benchmark (1M tris, Bun + Worker) | none |
| query-library, map-viewer, shell | wait for contracts M1 | contracts M1 |
| kanban | wait for infra M4/M5 | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. **S2:** on the machine with Deadlock installed, install Source2Viewer CLI, then start a session in `map-extractor` and paste the output of `ls` on the game's `game/citadel/maps` folder plus the CLI `--help`. Claude writes the rest.
3. **Cloudflare (M4):** create account + Pages project, then add the secrets listed in `docs/secrets.md`.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Label `infra` for root/tooling changes; title prefixed `[<module-id>]`.
