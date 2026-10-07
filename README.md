# deadlock-query

A static website for spatial questions about the Deadlock map: a TypeScript query editor with suggestions, a 3D map viewer with annotation tools, and local CLIs that extract the map and capture in-game screenshots.

Prod is published to GitHub Pages at https://malcolmmacdonald.github.io/deadlock-query. Dev runs on Cloudflare Pages behind a login (see [docs/dev-site.md](docs/dev-site.md)).

## Getting started
```
bun install
bun run verify:all     # every module's typecheck, lint-free tests and e2e
```
Agents and contributors: read [CLAUDE.md](CLAUDE.md), then [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), then the module's `modules/<id>/CLAUDE.md`. [NEXT.md](NEXT.md) lists what to do next per module. One module per PR, and update that module's `STATE.md`.

## Layout
- `modules/` — one folder per module (contracts, spatial-core, map-extractor, map-viewer, query-library, query-builder, map-metadata, shell, screenshot-tool, infra, kanban), each with `PLAN.md`, `STATE.md` and `CLAUDE.md`.
- `functions/` — Cloudflare Pages functions: session auth and the GitHub proxy (`/api/github/*`).
- `tools/` — repo tooling: `build`, `check:scope`, `check:state`, `check:deps`, `check:data`, `publish-map`, `hash-password`, `new-module`.
- `data/` — `current-build.json` points at the published map bundle.
- `docs/` — operations: [runbook](docs/runbook.md), [dev site](docs/dev-site.md), [rollback](docs/rollback.md), [takedown](docs/takedown.md), [secrets](docs/secrets.md), [dry run](docs/dry-run.md).

## Common commands
- `bun run publish-map` — extract, tile, bake, check, upload and open the pointer PR for a new map bundle (`--dry-run` stops before upload; needs the game install, so run it on the dev machine).
- `bun run build` — build the site (`--target dev|prod`).
- `bun run check:data` — verify the published bundle against the budgets.
- Promote dev to prod: dispatch `deploy.yml` with `promote` (optional `ref`); rollback is the same dispatch with the last good SHA.
