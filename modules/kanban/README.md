# kanban operator guide

Dev-only board that turns GitHub issues into Claude runs. Everything goes through the `GitHubApi` service: tests and the standalone harness use `MockGitHubApi`, the dev site uses `ProxyGitHubApi` (the `/api/github/*` proxy, no token in the browser).

## One-time setup (needs a repo admin)
1. Secret `CLAUDE_CODE_OAUTH_TOKEN` (Settings → Secrets → Actions) so `claude.yml` can run Claude.
2. Variable `CLAUDE_ALLOWED_ACTORS`: comma-separated GitHub logins allowed to trigger runs. Empty means nobody can.
3. Dev site: `GITHUB_TOKEN_PROXY` (fine-grained token, this repo only: issues RW, pull requests RW, contents R, actions RW). See `modules/infra/docs/runbook.md`.

## Conventions
- Labels: exactly one `module:<id>` per issue (required); `claude` starts a run; `reverted` moves a card to Reverted.
- Branches `claude/<module>/<issue#>-<slug>`; PR titles `[<module>] ...`. The board links a PR to its issue by the branch name.
- Columns: Backlog → In Progress (`claude` label) → Review (PR open) → Done (closed or merged) → Reverted.
- Feedback: the drawer's "Send to Claude" posts an `@claude` comment, which re-triggers the run on the same branch.
- Promote to prod dispatches `deploy.yml` with `promote=true`; the button is enabled only while `main` CI is green.

## Running locally
`bun run dev:standalone` builds the harness with mock data into `harness/.app-dist/`.

## Known gaps
Approve / request-changes reviews and "Revert" (revert PR) need proxy endpoints that are not allowed yet; use `@claude` comments meanwhile.
