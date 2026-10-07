# Contributing map metadata

Map metadata is facts the game files do not give us (creep camps, Sinner's Sacrifice, healing orbs) and corrections to the generated navigation (walkable and no-go regions, extra links such as ziplines). Anyone can propose it; the project owner reviews and accepts it.

## Drawing (anyone)

1. Open the viewer with the map loaded and the **Metadata** panel.
2. Pick a kind button (or the tool of the same name in the Tools panel), then click the map. Points snap to the surface under the cursor.
   - **Camp, orb, sacrifice**: one click.
   - **Navigation link**: two clicks, start then end.
   - **Walkable region**: click each corner, press Enter to close. Use the flag (walkable, noGo, interior, water) shown above the list.
   - **Custom**: choose point, polyline or polygon first.
   - Escape removes the last point; Escape again leaves the tool.
3. Select a draft in **Your drafts** to name it, add a note or change its fields. Fields that would not pass the schema are refused with the reason.
4. Drafts are saved in this browser (one database per map and build), so a reload or a closed tab loses nothing. Clearing site data does.

## Checks

The **Checks** list shows what a reviewer will see. Errors block submitting; warnings do not.

| Code | Meaning |
|---|---|
| `duplicate-nearby` | Another record of the same kind is closer than the kind's radius (camp 200, sacrifice 200, orb 100 units). |
| `polygon-self-intersects`, `polygon-repeated-vertex` | The region outline crosses or touches itself. |
| `polygon-too-large`, `polygon-no-area` | Outside sane limits. |
| `out-of-bounds` | A point is outside the map. |
| `not-on-surface`, `no-surface`, `inside-solid` | Needs the map's collision; the editor says when these checks are skipped. |
| `regions-overlap` (warning) | Two regions with the same flag overlap at nearly the same floor height. |

## Submitting

Press **Review & submit**, enter a display name (and optionally a GitHub handle; both are self-declared and shown to reviewers as unverified), then:

- **Submit** (when the site has the submission service): sends the drafts; you get a link to the pull request.
- **Download + issue** (always available): download the `metadata-submission-<id>.json` file, then open the prefilled GitHub issue and paste the file or drag it in.

Submissions never change published data. They arrive as a pull request adding `data/submissions/<id>.json`.

## Reviewing (project owner, dev site)

Open **Review**: the queue lists open submission pull requests. Open one to see the proposed features on the map, each record's validation results, and the submitter's note. Accept or reject each record (or *Accept all valid* / *Reject all*), add a comment, then **Commit decisions**: accepted and rejected records are written to `data/metadata/<build>/<kind>.json` on the pull request with your name and the date, and the pull request is merged (closed when nothing was accepted). **Request changes** only comments; **Reject submission** closes it with the reason.

## Publishing and new builds (maintainers)

- `bun run metadata:validate -- data/metadata/<build> --manifest <manifest.json>` checks a build directory.
- `bun run metadata:merge -- data/metadata/<build>` writes `metadata.bundle.json` (deterministic, hash-verified); `--check` fails when it is stale.
- After a game update, `bun run metadata:rebase -- --from data/metadata/<old> --manifest <new manifest.json>` carries accepted records to the new build and marks the ones that no longer fit as `stale` (with the reason). A reviewer then re-confirms or moves them; nothing is dropped silently.

## Rules for submitters

Draw only what you have checked in game. One feature per place; do not submit the same camp twice. Text fields are plain text and are never rendered as markup. Do not submit anything copied from elsewhere unless you may share it.
