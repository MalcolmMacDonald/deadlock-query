# kanban — plan

## 1. Purpose & scope
**Dev-deployment-only** board for instructing Claude to build features remotely, based on https://github.com/MalcolmMacDonald/github-kanban (React component `@malcolmmacdonald/github-kanban`: GitHub issues → configurable columns, CI status, issue creation, PAT auth, token-count extraction, optional "Promote to Prod" workflow dispatch). It adds: **one section per module**, **per-feature feedback**, and the **GitHub Actions that actually run Claude**, with the guarantee that **each feature impacts a single module**.

**Non-goals:** not a general project-management tool; no backend; does not contain the Claude agent itself (it uses `anthropics/claude-code-action`).

## 2. Ownership boundary
`modules/kanban/**`, plus the workflows `/.github/workflows/claude.yml` and `/.github/workflows/scope-check.yml`, and `/.github/ISSUE_TEMPLATE/feature.yml`. `devOnly: true` — excluded from the prod build.

## 3. Published surface
- Panels: `kanban.board` (module lanes), `kanban.feature` (detail/feedback drawer), `kanban.settings`.
- GitHub-side conventions (documented in `README`, enforced by workflows): labels `module:<id>` (exactly one, required), `claude` (start work), `needs-feedback`, `blocked`; branch naming `claude/<module>/<issue#>-<slug>`; PR title `[<module>] ...`.
- Workflows: `claude.yml` (run Claude on labelled issues / `@claude` comments), `scope-check.yml` (required PR check).

## 4. Uses
`contracts` (`ModuleDefinition`, `DevAuth` tag) and the repo's `module.json` files (read at build time → lanes, labels). All GitHub calls go through the `DevAuth` proxy provided by infra (D9): no token in the browser; unauthenticated → lock screen, `@malcolmmacdonald/github-kanban` (npm dependency; pinned version).

## 5. Technical design
**Board**: `kanban.board` renders a **swimlane per module** (collapsible, reorderable by the user; module order and visibility persisted) — implemented as one `<Board>` per module with that module's label filter (if github-kanban lacks the props needed, contribute a small upstream PR in that repo first and record it in `STATE.md`). Columns: Backlog → In Progress (Claude working) → Review (PR open, CI status shown) → Done → Reverted. Global header: CI state of `main`, "Promote to Prod" (workflow dispatch of `deploy.yml` with `promote=true`), token usage totals (from Claude comments, via github-kanban's extraction).

**Creating a feature**: form with module (required dropdown from manifests), title, description, acceptance criteria → creates an issue from `feature.yml` template with `module:<id>`. "Start" adds `claude` label ⇒ workflow runs.

**Feedback on individual features**: card drawer with thread (issue + linked PR comments + review comments), a feedback box posting a comment prefixed `@claude` (re-triggers the agent on the same branch), quick actions: "Approve", "Request changes", "Revert" (opens revert PR via API), "Split into follow-up issue". Feedback is therefore stored in GitHub, visible to Claude via normal comment context.

**Running Claude** (`claude.yml`): trigger on `issues.labeled` (`claude`) and `issue_comment`/`pull_request_review_comment` containing `@claude` by an allowlisted actor. Steps: checkout → determine module from label (fail if 0 or >1) → `anthropics/claude-code-action` with a prompt template:
> "Implement issue #N strictly inside `modules/<id>/`. Read `modules/<id>/CLAUDE.md`, `PLAN.md`, `STATE.md` first. Do not edit any other path; if another module/contracts needs a change, record it under 'Blockers / Requests' in STATE.md and stop. Run the module's `verify` command. Update `STATE.md` and bump `module.json` version per SemVer rules. Open/refresh a PR from `claude/<id>/<N>-slug`."
Tool/permission allowlist restricts shell to bun/dotnet/git in the module scope; secrets: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, actor allowlist so strangers cannot trigger runs (public repo!), concurrency group per module (one run per module at a time, different modules in parallel).

**Single-module enforcement** (`scope-check.yml`, required status): computes changed paths; passes only if all changes lie within one `modules/<id>/` directory (shell-owned `tools/check-scope` logic reused or vendored), the label `module:<id>` matches, and `STATE.md` changed. Cross-module needs ⇒ separate issues; the board shows "requests" extracted from STATE.md as suggested cards for other modules (v2).

**Auth/security**: the browser holds only an HttpOnly session cookie from infra's password gate; the GitHub token lives in the dev Function (fine-grained, this repo only: issues RW, PRs RW, contents R, actions RW) and requests are restricted to an allowlist of endpoints. UI never renders issue text as HTML (markdown sanitised). Prompt-injection note: issue/comment text is untrusted input to Claude → allowlisted authors only, no secrets exposed to the job beyond what the action needs, and branch protection requires human merge.

**Polling/rate limits**: ETag-conditional requests, 30 s default interval (configurable), pause when tab hidden.

## 6. Milestones
**Phasing:** Track B of Phase 1, **in parallel with the product slice** — this is how the remaining modules get built remotely. Needs infra M1 (checks) and M4–M5 (dev site + proxy) for the real flow; M0–M2 can proceed on mocks immediately.

| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Scaffold; add `github-kanban` dependency; `kanban.board` with a single lane against a mock GitHub API; lock screen when `DevAuth` has no session | Standalone harness works with fixture issues |
| M1 | Lanes per module from manifests, label filtering, lane collapse/reorder persisted | Playwright: lanes appear for all modules in fixture manifests |
| M2 | Feature creation form + issue template + required `module:` label | Created issue has exactly one module label (mock + sandbox repo) |
| M3 | `claude.yml` + prompt template + allowlist + per-module concurrency; documented secret setup | Test issue on sandbox repo yields branch + PR touching only its module |
| M4 | `scope-check.yml` required check + tests with synthetic diffs | Multi-module diff fails, single-module passes |
| M5 | Feedback drawer (comments → `@claude` re-trigger), approve/request-changes/revert actions | Round-trip on sandbox repo: feedback comment triggers a new commit on same PR |
| M6 | Promote-to-Prod, CI status, token totals, notifications (title badge) | Dispatch creates deploy run |
| M7 | STATE.md "requests" surfacing, docs (`README` for operators: secrets, PAT, labels), hardening review | Security checklist signed off in `STATE.md` |

## 7. Test strategy
Unit tests for label/branch conventions, scope-check logic, request-extraction parser; component tests with fixture GitHub responses; workflow YAML linted (`actionlint`); end-to-end only on a throwaway sandbox repo (opt-in, documented).

## 8. Standalone mode
`bun run dev:standalone` uses a mock GitHub server (recorded fixtures) and fake `DevAuth`.

## 9. Risks & open questions
- `claude-code-action` capabilities/permissions model and cost per run **[VERIFY]**; need monthly budget/limits (**[DECISION]**).
- Prompt injection via issues/comments on a public repo → strict actor allowlist; consider making the repo's issue creation restricted to collaborators.
- github-kanban may need upstream changes for per-lane filtering/feedback; coordinate via PRs in that repo.
- Depends on infra's dev site (Cloudflare Pages Functions, D9) being up first; until then use the standalone mock. Fallback `LocalPatAuth` is acceptable for early development.
- Simultaneous module work may still produce merge conflicts in shared files (`bun.lock`); `check:scope` (infra) allows `bun.lock` alongside the module's own changes (D13); the merge queue regenerates it on conflict.

## 10. Definition of done
From the dev site, with the password, an operator creates a feature for a module, Claude implements it on a branch, CI and scope-check pass, the operator gives feedback and approves, merges, and promotes to prod — all without leaving the board; two modules can be developed simultaneously; secrets/permissions documented and reviewed.
