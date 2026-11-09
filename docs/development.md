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

| Scenario                                                                 | Covers                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`                                                                  | The harness itself: a disposable Rex session, teardown, guard hashes                                                                                           |
| `launch`                                                                 | Direct argv launch, TTY, cwd, instructions, model inheritance and override, thinking clamp                                                                     |
| `status`                                                                 | Pi's native status in Rex, a blocking dialog, attention notices, `/subagents go`                                                                               |
| `failures`                                                               | Provider errors, handled tool errors, aborts, cutoffs, bad results, oversized output, a hang after the result                                                  |
| `continuation`                                                           | `continueFrom` forks and leaves the source unchanged                                                                                                           |
| `takeover`                                                               | Steering, interruption, takeover against settlement and cancellation, reload after takeover                                                                    |
| `trust`                                                                  | The project-trust prompt raises a notice, and the decision stays Pi's                                                                                          |
| `admission`                                                              | Writer exclusion across parents, path identity, worktrees, ceilings, `limits.json`                                                                             |
| `parallel`                                                               | Several real parallel calls in one message, abort, the parent guard                                                                                            |
| `recovery`                                                               | Rex unreachable, launch timeout, parent crash, reload with a taken-over child                                                                                  |
| `terminals`                                                              | Moves and splits, clear and dismiss by exact block ID                                                                                                          |
| `read`, `readers`                                                        | Read restrictions and `git_read` under attack, reader admission                                                                                                |
| `inspect`                                                                | Inspect restrictions and the checkout fingerprint                                                                                                              |
| `double-load`                                                            | The extension loaded twice in one process registers once                                                                                                       |
| `background`, `background-cap`, `background-reload`, `background-switch` | Background delivery, the cap, reload and crash recovery, session transitions                                                                                   |
| `compose`                                                                | Investigation, implementation, review, and worktree compositions through the public tools                                                                      |
| `control`                                                                | Model-driven list/message/cancel, cross-parent scoping, real Rex status, working steering, idle prompting, dialog safety, stale lock, queued/live cancellation |
| `nesting-model`                                                          | Real model-driven same-checkout foreground read review at active=1, model override, immediate-parent result                                                    |
| `nesting`                                                                | Sibling-tool join-wait, write guard, descendant priority, internal FIFO, busy coalescing before publication                                                    |
| `nesting-capacity`                                                       | Coordinator/worker/review parking, edited ceilings, wake-before-ticket priority, parked and descendant takeover                                                |
| `nesting-human`                                                          | Human typing and provider changes clear parking and count immediately above the ceiling                                                                        |
| `nesting-cycle`                                                          | Cross-tree and wrapper wait-cycle refusal, inspect defaults/write refusal, depth-limit toolsets                                                                |
| `nesting-inbox`                                                          | Cancelled descendant plus accepted unsent message persisted in one turn, both processed before publication                                                     |
| `nesting-races`                                                          | Public descendant list/cancel, in-flight Rex reply cleanup, orphan retention without upward delivery                                                           |
| `control-races`                                                          | Deterministic settlement orderings, takeover's pending messages and cancellation refusal, hung result cancellation, parent crash after cancellation claim      |
| `attention`                                                              | Oldest-wait selection from another session, OSC 9 once per wait, same-session move, dropped event stream reconciled through liveness                           |

Every run gets its own scratch directory under the system temp directory, its own state and session directories, and Rex sessions labelled `pirs-h-`. Teardown removes only the sessions this run created, and removes the scratch directory, even when the run fails. A run refuses to start if a `pirs-h-` session is left over from an earlier run. Run output is archived under the git-ignored `.harness-runs/`.

Each run hashes Pi's `settings.json`, any installed `extensions/subagent.ts`, and `trust.json` before and after, plus every path in the colon-separated `HARNESS_GUARD_FILES`. It fails if any of them changed.

- `HARNESS_MODEL` selects the model for children, and for parents unless `HARNESS_PARENT_MODEL` is set. The default is `openrouter/nvidia/nemotron-3.5-lightning:free`. Any cheap model you are logged in to works; the harness tests lifecycle, not task quality.
- `HARNESS_OVERRIDE_MODEL` is the explicit override in the `launch` scenario. It must differ from `HARNESS_MODEL`, and a different provider makes the check stronger.
- `HARNESS_FAILURE_CASE` takes one case of the `failures` scenario, or a comma-separated list.

Free models have daily request limits. If a scenario fails with HTTP 429, wait for the limit to reset or switch `HARNESS_MODEL` instead of rerunning it. Keep the machine awake during long runs (`caffeinate -i` on macOS); a sleep mid-run fails the scenario on timeouts or connection errors.

The trust scenario expects Pi's default `"ask"` trust policy. It checks that the selected answer is "this session only" before pressing Enter, so it never saves a trust decision.

The installed Rex cannot move a block or a window into another session. `attention` therefore checks a same-session move to another tab. The acceptance check for a child moved to another session waits on a Rex version that can do that move. The parent already follows `rex events --all --json`, so that case needs no extension change when Rex gains it.

## Testing hooks

These environment variables exist for the harness. They are not user features.

- `PI_SUBAGENTS_CHILD_NO_DISCOVERY=1` adds `--no-extensions` to children, so the user's installed extensions do not load in harness children.
- `PI_SUBAGENTS_CHILD_EXTENSIONS` lists extra extension paths passed to children, such as the harness's dialog, hold, and fault tools.
- `PI_SUBAGENTS_LOG_TOOLS` makes child reporters log every tool call with its arguments.
- `PI_SUBAGENTS_FINGERPRINT_MAX_BYTES` and `PI_SUBAGENTS_FINGERPRINT_MAX_MS` lower the inspect fingerprint budget.
- `PI_SUBAGENTS_COALESCE_MS` overrides the three-second idle delivery window.
- `PI_SUBAGENTS_ADMISSION_METRICS` records admission lock timings.
- The `subagents:test-takeover-claimed` event on Pi's extension bus lets a harness extension delay the takeover acknowledgement after the claim.
- `subagents:test-settlement` provides a test-only boundary object with `before` (an awaitable barrier) and `hold` (stay idle for this boundary). The harness uses it to force pre-publication messaging and a held-idle child without registering another settlement owner.
- `subagents:test-cancel-claimed` lets the harness SIGKILL its own disposable parent between a durable cancellation claim and signalling. `HARNESS_CANCEL_CRASH=1` enables that listener only in the harness extension.

`pnpm exec vitest run test/inbox.test.ts --reporter=verbose --disableConsoleIntercept` prints the exhaustive protocol differential's state count and runtime. `models/export_protocol.py` exports every reachable current state, not a random sample. The tests also exercise private ack files, persisted-user consumption, timeout handling, ancestry scoping, and parent-only stale-lock recovery without a reporter helping.

Phase-six deterministic plans replace assistant tool-call batches rather than
wrapping launches in a holding tool, which would itself hold join-wait. A
foreground wrapper has a separate cycle-refusal check. A real provider runs on
every turn; assertions read records, events, and persisted session rows, not the
model's wording. `nesting-model` uses no fixed plan.

The live graph adds started-tool join blockers and known caller-dependency edges
to the admission model's facts. The same pure TypeScript admission core and
Python differential runner remain the oracle; no expected model result changed.
