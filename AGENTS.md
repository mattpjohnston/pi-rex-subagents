# Working on pi-rex-subagents

This repository is the user's live Pi extension. `main` must work at every commit.

Start each session by reading `docs/progress.md`, the last 20 lines of `git log --oneline`, and `docs/roadmap.json`. Take the first item whose status is not `done`. README.md, docs/design.md and docs/development.md explain the code. The approved spec is `~/Documents/rex-pi-subagent-spec/vision-and-requirements.md`.

- One roadmap item, or one idea, per commit. A behaviour change starts with a test that fails without it. A refactor changes no behaviour.
- `scripts/check.sh` must pass before every commit. Push to main once it does, and check CI.
- Set an item's status to `done` only after every check in its `done` list has run and been observed. Record the evidence and the commit. Never edit or remove an item's checks.
- Append to `docs/progress.md` when an item finishes or a session ends: what was done, the evidence, what failed, what's next.
- A change to a rule the Python models cover changes the model first, and the old rule must fail it.
- Record a change to the spec in the spec, dated, with the reason.
- Never stop or restart the Rex server, touch Rex sessions you didn't create, or edit `~/.pi/agent` by hand. The harness creates and removes its own `pirs-h-` sessions.
- Run the harness inside `caffeinate -i`, with `HARNESS_MODEL=opencode-go/deepseek-v4.1-flash HARNESS_OVERRIDE_MODEL=anthropic/claude-haiku-4-5`.
