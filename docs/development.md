# Development

Use Node 26 and pnpm. Pi loads the TypeScript directly, so there is no build step.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm test
pnpm models
```

CI runs the same checks and the models on every push.

## Acceptance harness

`pnpm harness <scenario>` runs one scenario against real Pi and Rex. Scenarios live in `harness/scenarios/`.

| Scenario                                                                 | Covers                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `empty`                                                                  | The harness itself: a disposable Rex session, teardown, guard hashes                                          |
| `launch`                                                                 | Direct argv launch, TTY, cwd, instructions, model inheritance and override, thinking clamp                    |
| `status`                                                                 | Pi's native status in Rex, a blocking dialog, attention notices, `/subagents go`                              |
| `failures`                                                               | Provider errors, handled tool errors, aborts, cutoffs, bad results, oversized output, a hang after the result |
| `continuation`                                                           | `continueFrom` forks and leaves the source unchanged                                                          |
| `takeover`                                                               | Steering, interruption, takeover against settlement and cancellation, reload after takeover                   |
| `trust`                                                                  | The project-trust prompt raises a notice, and the decision stays Pi's                                         |
| `admission`                                                              | Writer exclusion across parents, path identity, worktrees, ceilings, `limits.json`                            |
| `parallel`                                                               | Several real parallel calls in one message, abort, the parent guard                                           |
| `recovery`                                                               | Rex unreachable, launch timeout, parent crash, reload with a taken-over child                                 |
| `terminals`                                                              | Moves and splits, clear and dismiss by exact block ID                                                         |
| `read`, `readers`                                                        | Read restrictions and `git_read` under attack, reader admission                                               |
| `inspect`                                                                | Inspect restrictions and the checkout fingerprint                                                             |
| `double-load`                                                            | The extension loaded twice in one process registers once                                                      |
| `background`, `background-cap`, `background-reload`, `background-switch` | Background delivery, the cap, reload and crash recovery, session transitions                                  |
| `compose`                                                                | Investigation, implementation, review, and worktree compositions through the public tools                     |

Every run gets its own scratch directory under the system temp directory, its own state and session directories, and Rex sessions labelled `pirs-h-`. Teardown removes only the sessions this run created, and removes the scratch directory, even when the run fails. A run refuses to start if a `pirs-h-` session is left over from an earlier run. Run output is archived under the git-ignored `.harness-runs/`.

Each run hashes Pi's `settings.json`, any installed `extensions/subagent.ts`, and `trust.json` before and after, plus every path in the colon-separated `HARNESS_GUARD_FILES`. It fails if any of them changed.

- `HARNESS_MODEL` selects the model for children, and for parents unless `HARNESS_PARENT_MODEL` is set. The default is `openrouter/nvidia/nemotron-3.5-lightning:free`. The harness tests lifecycle, not task quality.
- `HARNESS_FAILURE_CASE` runs one case of the `failures` scenario.

Free models have daily request limits. If a scenario fails with HTTP 429, wait for the limit to reset instead of rerunning it.

The trust scenario expects Pi's default `"ask"` trust policy. It checks that the selected answer is "this session only" before pressing Enter, so it never saves a trust decision.

## Testing hooks

These environment variables exist for the harness. They are not user features.

- `PI_SUBAGENTS_CHILD_NO_DISCOVERY=1` adds `--no-extensions` to children, so the user's installed extensions do not load in harness children.
- `PI_SUBAGENTS_CHILD_EXTENSIONS` lists extra extension paths passed to children, such as the harness's dialog, hold, and fault tools.
- `PI_SUBAGENTS_LOG_TOOLS` makes child reporters log every tool call with its arguments.
- `PI_SUBAGENTS_FINGERPRINT_MAX_BYTES` and `PI_SUBAGENTS_FINGERPRINT_MAX_MS` lower the inspect fingerprint budget.
- `PI_SUBAGENTS_COALESCE_MS` overrides the one-second idle delivery window.
- `PI_SUBAGENTS_ADMISSION_METRICS` records admission lock timings.
- The `subagents:test-takeover-claimed` event on Pi's extension bus lets a harness extension delay the takeover acknowledgement after the claim.
