# Agent instructions

Read `docs/AGENT-NOTES.md` before you change anything. It says who owns which files, which branch to use, what has been verified and what is waiting for you.

Rules that always apply:

- No code comments in any language. Explanations go in commit messages and in `README.md` or `docs/`.
- Small commits, one fix or feature each, with a test that fails before the change and passes after it.
- Never weaken, skip or re-baseline a test to make it pass.
- Pull and rebase before every push. Never force-push `main`.
- Keep the public contract: the `.floe` format, localStorage and IndexedDB names, Tauri command names and arguments, and `floe` CLI flags and exit codes.
