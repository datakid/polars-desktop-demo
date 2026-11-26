# Handover: reviewer (Floe repo)

Repo: https://github.com/datakid/floe (formerly polars-desktop-demo). Local clone: /home/claude/polars-desktop-demo. Branch: `main` only.
Board: `docs/AGENT-NOTES.md` (newest messages at the top of "## Messages"). Read it before doing anything.

## State at handover (2026-11-26)
- `main` = 42e5ea9 (engine agent's handover note on top of 29b19a8 claim for task 1).
- Release `v1.1.0-alpha.8` (commit 4ff96d9): published with 2 `.exe`, 2 `.deb`, `.sha256` files and notes. Its 12 Linux smoke legs all passed. CI on 4ff96d9 green.
- Tag `v1.1.0-alpha.7` (6d45257) is the previous release.
- Repo rename: old name `polars-desktop-demo` redirects; use `datakid/floe`.
- No branches except `main` (plus unrelated remote branches `feat/*`, `polish/*`, `ci/*`, `deps/*`, not ours; do not delete).

## Done by the reviewer
- Merge dialog layout and key logic fixed (`04b8914`, `7b055a0`), tests in `tests-ui.html`.
- Docs corrected: README counts, installer sizes, BENCH wording (`afb1ad2`); limits stated (`6d45257`, `8667091`).
- Python export parity: 82 cases in `scripts/check-python-export.mjs`, all match (`757d2f7`, `f00d482`, `76b5662`, `05fb377`).
- Built-in CSV writes every datetime row in full (`76b5662`).
- Polars CSV writes booleans `TRUE`/`FALSE` (`e4e1c0f`, test `bccc66f`), proven red then green in CI.
- Linux: `.deb` for both engines, 12-leg smoke matrix on Ubuntu 22.04/24.04/26.04/26.10 (X11, headless Wayland), checks launch with `.floe` file and `Ctrl+,`. Docs in `docs/LINUX.md`.

## Open items and who owns them
1. **Task 1, P3 Custom SQL on Polars** — claimed by the engine agent (`29b19a8`), not started in code. Built-in is alasql in `X.CustomSql` (`js/engine.js`). Acceptance criteria are on the board (25+ parity statements, allow-list, runtime fallback, documented differences). Engine agent asks the reviewer for a run-time fallback test in `tests-ui.html`: add it or allow it.
2. **Task 2, review of Linux work** — engine agent, read only, after task 1.
3. **Reviewer open work:** none blocking. Optional: extend smoke test to F5 and Ctrl+E; Windows has no automated shortcut test; dark-theme and real phone not visually verified beyond screenshots.
4. **Security:** the GitHub token pasted into the first chat must be rotated by the user. It is stored only in `/home/claude/.gh_token` (chmod 600) and must not be committed.

## Rules (also in AGENTS.md)
- No code comments in any language, no TODOs. Explanations go in commit messages, README, docs.
- Small commits, one fix each, a test that fails before and passes after.
- Never weaken or re-baseline a test. Never force-push `main`. Pull/rebase before push.
- Keep public contract: `.floe` format, localStorage/IndexedDB keys, Tauri command names and args, CLI flags and exit codes.
- Do not tag without green CI on the commit.
- Stop and report if the same blocker survives two attempts.

## Environment and how to work
- No `cargo` in the sandbox: Rust is verified only in CI. Use a branch-free flow: push to `main` (or a short-lived branch, deleted after) and read the run.
- Browser tests: headless Chromium from npm `@sparticuz/chromium` + `playwright-core` in `/home/claude/browser`. Runner: `/home/claude/browser/run.mjs`. Gate script: `/home/claude/gate.sh tests.html tests-ui.html` (starts `python3 -m http.server 8766` in the repo).
- Web build: `node scripts/build-web.mjs --target web|desktop`. Fixtures: `node scripts/gen-fixtures.mjs`. Export parity: `node scripts/check-python-export.mjs` (needs `pip install polars`).
- CI and release status: GitHub API with the token in `/home/claude/.gh_token`. Helper scripts: `/home/claude/relstat.sh` (release run; set RID in `/home/claude/rel_run`), `/home/claude/smoke_status.py <token> <run_id>` (per-leg annotations).
- Release: Actions → `release.yml` via API dispatch with `{"ref":"main","inputs":{"tag":"vX.Y.Z-..."}}`. It builds Windows and Linux, runs the Linux matrix, publishes. Check the run; check assets afterward.
- Git identity set locally: Claude <noreply@anthropic.com>. Remote: https://github.com/datakid/floe.git.

## Next steps for a new chat
1. `git -C /home/claude/polars-desktop-demo fetch && git status` and read `docs/AGENT-NOTES.md` messages.
2. If the engine agent has pushed P3 work, review it against its acceptance criteria before merging; write the run-time fallback test in `tests-ui.html` if asked.
3. If nothing new: nothing blocks a release; the current release is `v1.1.0-alpha.8`.
