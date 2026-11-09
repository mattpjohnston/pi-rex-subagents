# Development

You need Node 26 and pnpm. Pi loads the TypeScript directly, so there's no build step.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm test
pnpm models
```

CI runs all of these on every push.

`node harness/refresh-cost.ts` measures Rex calls and elapsed time per parent refresh. Use `copy <state-dir> <parent-pi-session-id> [passes]` to measure a copy of existing records, or `synthetic <runs> <sessions> [passes]` to create temporary runs and Rex sessions.

## End-to-end tests

The tests in `harness/` start a real Pi and real Rex, launch subagents through the extension, and check what actually happened: tabs, run records, result files, session files, and changed files. Run one with:

```sh
pnpm harness <scenario>
```

Scenarios live in `harness/scenarios/`:

| Scenario            | Checks                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `empty`             | The test setup itself: a throwaway Rex session is created and removed                                         |
| `launch`            | Launching, the working directory, instructions, model inheritance and overrides, thinking levels              |
| `status`            | Pi's status in Rex, a dialog waiting for you, the notice, `/subagents go`                                     |
| `failures`          | Provider errors, tool errors, aborts, cut-off replies, bad results, oversized output, a hang after the result |
| `continuation`      | `continueFrom` copies the conversation and leaves the original untouched                                      |
| `takeover`          | Steering, interrupting, and taking over in every order against finishing and cancelling                       |
| `trust`             | Pi's trust prompt raises a notice, and the decision stays with Pi                                             |
| `admission`         | Writers kept apart across parents, path handling, worktrees, caps, `limits.json`                              |
| `parallel`          | Several calls in one message, aborting them, refusing the parent's edits                                      |
| `recovery`          | Rex unreachable, a launch timeout, a parent crash, reloading with a taken-over subagent                       |
| `terminals`         | Moving and splitting tabs, `/subagents clear` and `dismiss`                                                   |
| `autoclose`         | Finished tabs close after the delay, stay while viewed, and stay when pinned                                  |
| `retention`         | Old delivered runs deleted at startup; undelivered, taken-over, unresolved and recent runs kept               |
| `read`, `readers`   | Read-only restrictions and `git_read` against hostile repositories, readers sharing a repository              |
| `inspect`           | Inspect restrictions and change detection                                                                     |
| `double-load`       | The extension loaded twice in one Pi registers once                                                           |
| `background`        | Background results, batching, and cancelling                                                                  |
| `background-cap`    | The size cap on a batch of results                                                                            |
| `background-reload` | Reloads and crashes while background subagents run                                                            |
| `background-switch` | `/new`, `/resume`, `/fork`, `/clone`, quit, and `/tree`                                                       |
| `compose`           | Investigation, implementation, review, and worktree setups through the public tools                           |
| `control`           | `subagent_control` driven by a real model                                                                     |
| `control-races`     | Messages and cancelling as a subagent finishes or is taken over, and a parent crash mid-cancel                |
| `nesting-model`     | A subagent starting its own subagent, driven by a real model                                                  |
| `nesting`           | Nested subagents in a shared repository, ordering, and refused edits                                          |
| `nesting-capacity`  | Parked runs and the caps                                                                                      |
| `nesting-human`     | Typing in or changing the model of a parked subagent                                                          |
| `nesting-cycle`     | Refusing launches that would deadlock, and the depth limit                                                    |
| `nesting-inbox`     | Nested results and messages arriving together                                                                 |
| `nesting-races`     | Cancelling a tree of subagents, including a launch Rex hasn't answered yet                                    |
| `attention`         | Jumping to the oldest waiting subagent, no desktop notifications, and a dropped event stream                  |

Each run gets its own temporary directory, state, and session directories, and Rex sessions named `pirs-h-...`. When it ends, pass or fail, it removes the sessions it created and its temporary directory, and nothing else. It refuses to start if a `pirs-h-` session is left from an earlier run. Output is kept in `.harness-runs/`, which git ignores.

Each run hashes Pi's `settings.json`, `extensions/subagent.ts`, and `trust.json` before and after, plus any files listed in `HARNESS_GUARD_FILES` (colon-separated), and fails if one changed. Pi itself updates `settings.json` once after this package's version goes up, when it records that it has shown the changelog, so the first run after a version bump can fail this check.

Settings for the tests:

- `HARNESS_MODEL` is the model for subagents, and for parents unless `HARNESS_PARENT_MODEL` is set. It defaults to a free OpenRouter model. Any cheap model you're logged in to works, since the tests check behaviour, not answer quality.
- `HARNESS_OVERRIDE_MODEL` is the model the `launch` scenario switches to. It must differ from `HARNESS_MODEL`, and a different provider is a better test.
- `HARNESS_FAILURE_CASE` runs one case of `failures`, or a comma-separated list.

Free models have daily limits. If a scenario fails with HTTP 429, wait for the limit to reset or use another model rather than rerunning. Keep the machine awake during long runs (`caffeinate -i` on macOS), because sleeping mid-run causes timeouts.

The `trust` scenario needs Pi's default `"ask"` trust setting. It checks that "this session only" is selected before pressing Enter, so it never saves a trust decision.

Rex can't move a tab into another session, so `attention` tests a move to another tab in the same session instead. The extension follows `rex events --all --json`, which would already cover a move between sessions.

The tests assert on records, events, and saved sessions, never on what the model wrote.

## Test-only settings

The tests use these. They aren't meant for normal use.

- `PI_SUBAGENTS_CHILD_NO_DISCOVERY=1` starts subagents with `--no-extensions`, so your own installed extensions don't load in test subagents.
- `PI_SUBAGENTS_CHILD_EXTENSIONS` lists extra extensions to load in subagents, such as the tests' dialog, hold, and fault tools.
- `PI_SUBAGENTS_LOG_TOOLS` logs every tool call a subagent makes, with its arguments.
- `PI_SUBAGENTS_FINGERPRINT_MAX_BYTES` and `PI_SUBAGENTS_FINGERPRINT_MAX_MS` lower the size and time limits for `inspect` change detection.
- `PI_SUBAGENTS_COALESCE_MS` changes the 3-second wait before sending results to an idle parent.
- Three events on Pi's extension bus let test extensions pause the extension at precise points: `subagents:test-takeover-claimed` (after a takeover is claimed, before it's acknowledged), `subagents:test-settlement` (before a subagent finishes), and `subagents:test-cancel-claimed` (after a cancel is claimed, before the signal). `HARNESS_CANCEL_CRASH=1` makes the test parent kill itself at that last point.

`pnpm exec vitest run test/inbox.test.ts --reporter=verbose --disableConsoleIntercept` prints how many protocol states the model comparison checked and how long it took.
