# Working on pi-rex-subagents

This repository is the user's live Pi extension. `main` must work at every commit.

README.md and docs/design.md explain the extension. Keep it KISS: small, flat (depth 1), event-driven, leaning on Pi and Rex's native features rather than rebuilding them.

- One idea per commit. A behaviour change starts with a regression test that fails without it. A refactor changes no behaviour.
- `scripts/check.sh` must pass before every commit (typecheck, oxlint `--type-aware --deny-warnings`, oxfmt, vitest, and vitest with no `rex` or `pi` on `PATH`). Push to `main` once it passes and verify CI.
- Never stop or restart the Rex server, touch Rex sessions you didn't create, or edit `~/.pi/agent` by hand. Any live Rex smoke test must create and remove its own `pirs-h-` session and use a temporary `PI_SUBAGENTS_STATE_DIR`.
