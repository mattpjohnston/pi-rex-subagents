# Pi Rex Subagents

A Pi extension for delegated Pi processes in retained Rex terminal tabs. **Under construction; not ready to install as a replacement for an existing subagent extension.**

## Phase 1

The `subagent` tool runs a foreground `write` task in a background tab of the parent's Rex session. Calls are not declared sequential. The child inherits the parent's effective provider, model and thinking level unless overridden. Ask for a short final report and put bulk output in a file the report names.

Inputs: `task`, optional `label`, `cwd`, `access`, `background`, `continueFrom`, `provider`, `model`, and `thinking`. `read`, `inspect`, and `background: true` are explicitly rejected in this phase. An explicit `model` containing a slash means `provider/model` when no separate provider is supplied. For a provider's own slash-containing ID, supply `provider` separately. Inherited model IDs are never reinterpreted.

The parent must run inside a local Rex session. Children use direct argv, normal Pi trust decisions, fresh private session directories, and an explicit result channel rather than terminal scraping. Startup has a 60-second deadline; ordinary tasks have no time limit. Post-result shutdown has a 10-second grace and cancellation has a 30-second grace. A recorded answer without confirmed process exit is marked unresolved, not confirmed completion. Rex `done` is never proof of success.

- `/subagents` lists this parent's runs, waiting first, up to 30 entries.
- `/subagents all` lists live children across parents.
- `/subagents go <label>` resolves the stable block's current location and selects it in Rex.
- The parent widget lists live children. Notices identify blocking dialogs and project-trust waits.
- Escape in the parent cancels foreground work through its durable claim.
- `/subagent-takeover` in the child transfers ownership before acknowledging it. The child stays alive across settlement and reload. Ordinary parent cancellation cannot kill it.
- `continueFrom` forks an earlier, confirmed-exited run's saved session into a new run. It never opens a second live writer on the source session.

Phase 2 admits foreground writers through a machine-wide file queue. A queued run stores `queue` (`checkout` or `capacity`); `waiting` is only a human dialog or trust prompt and is what raises an attention notice. Live child writers exclude one another on overlapping checkouts, including across parents. The active ceiling defaults to 4. Nested launches are refused: the effective depth is 1 until phase 6, whatever `limits.json` says. The parent's `edit` and `write` are refused inside a checkout held by a live child writer; `bash` is not. `/subagents clear` closes this parent's exited, completed, never-taken-over child blocks. `/subagents dismiss <label|run-id>` closes one exited child block.

## Phase 3

`access: "read"` launches with `--no-extensions --no-mcp --tools read,grep,find,ls,git_read` and the reporter. Instruction and skill discovery stay. `git_read` is an argv Git tool, registered only in a read child. It allows `log`, `show`, `blame`, `diff`, `ls-files`, `rev-parse`, `status`, `shortlog`, and `grep`, refuses the write and command flags named in the spec including unique long-option prefixes, and runs with an empty attribute source, private empty attributes and hooks, fsmonitor and external diff disabled, `log.showSignature=false`, and every `GIT_*` variable removed. A real Git probe confirmed that `-c log.showSignature=false` stops a repo-configured `gpg.program` from running, while plain `git log --show-signature` on the same commit does run it.

`access: "inspect"` is the normal write environment with `--exclude-tools edit,write`. Admission already counts it as a reader. The parent records a checkout fingerprint after admission and before the Rex launch, and again after confirmed exit. The result's `checkout` field is `clean`, `changed` with a bounded path list and a total count, or `unknown` when the 2 GB / 60 s budget is exceeded or the fingerprint cannot be completed. It never changes the outcome. The text says the checkout changed during the run, not that the child caused it. Children still have no `subagent` tool; a nested launch from an inspector is a phase 6 rule.

Restrictions are re-checked on every `session_start`, including `reload`, and again before the model acts. Pi handles `/reload` as a built-in before extension input, so a child cannot cancel the reload itself. The launch flags live on the session and resource loader and are not cleared by reload. If the callable set is no longer restricted, the reporter claims a failed result naming the extra tools and exits before the model acts.

## Durable state

State defaults to `getAgentDir()/subagents`, overridable with `PI_SUBAGENTS_STATE_DIR`. Directories are private (`0700`), files private (`0600`). Each `runs/<run-id>/` contains:

- `run.json`: a versioned, boundary-validated record containing label/task path, canonical cwd and checkout root, access, resolved requested settings before thinking clamp, effective settings, continuation reference, parent session/run/depth, immutable launch Rex IDs, current location, artifact paths, lifecycle, process observation, human-wait source/kind/title, admission `queue` reason/detail, diagnostics and timestamps. Ownership is not a record field.
- `result.json`: version, matching run ID, outcome, assistant text, session path, effective settings, stop reason, error/cutoff reason and finish time. It is atomically written before claiming the result.
- `claim`: exactly `result`, `taken_over`, or `cancelled`. A private temporary file is synced and hard-linked into place; first link wins. Empty or malformed claims are errors.
- `lock/holder.json`: PID, OS process start time and a holder token. Settlement, takeover and cancellation share this lock. Stale recovery requires the admission lock and proof the recorded holder is gone or replaced. An unidentified holder is retained conservatively, not deleted based on age.
- `task.md`, `events.jsonl`, `inbox/`, and `session/`: task, reporter diagnostics, future inbox and the complete Pi conversation.

Lifecycle: `admitting` → `starting` → `running` → `completed`, `failed`, `aborted`, `incomplete`, `taken_over`, or `cancelled`, with explicit failure/cancellation exits during startup. Process observation is separate: `live`, `exited` with exit code, `unresolved`, or `unknown` when Rex cannot be reached. Model-facing text, including metadata and a truncation notice, stays within 50 KB / 2000 lines.

Pi and Rex are discovered on `PATH`, overridable with `PI_SUBAGENTS_PI` and `PI_SUBAGENTS_REX`. Only non-secret configuration is forwarded through environment argv; provider credentials remain in Pi's credential storage. The reporter observes project trust and returns `undecided`, never a trust decision.

## Checks

Use Node 26 and pnpm. No build step is required for type-stripped TypeScript.

```sh
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm test
pnpm models
pnpm harness empty
pnpm harness launch
pnpm harness status
pnpm harness failures
pnpm harness continuation
pnpm harness takeover
pnpm harness trust
pnpm harness admission
pnpm harness parallel
pnpm harness recovery
pnpm harness terminals
pnpm harness read
pnpm harness readers
pnpm harness inspect
```

The harness uses real Pi and Rex, independent temporary state/session directories and only disposable Rex sessions it created. Outputs are archived under ignored `.harness-runs/`. Every run checks hashes of global settings, the installed subagent extension and the trust store, plus colon-separated `HARNESS_GUARD_FILES`. Teardown removes only this run's Rex sessions and scratch directory, including on failure. The trust scenario requires the caller's normal `ask` policy and verifies the selected **session-only** option before sending Enter; it must not save a trust decision.

`HARNESS_MODEL` selects the test model, defaulting to `openrouter/nvidia/nemotron-3.5-lightning:free`. The launch scenario exercises inheritance and an explicit provider/model selection. The parallel scenario's parent uses `HARNESS_PARENT_MODEL`, defaulting to `anthropic/claude-haiku-4-5`, because the free model has omitted required `cwd` values; its children still use `HARNESS_MODEL`. `HARNESS_FAILURE_CASE` optionally selects one failure case during debugging; omit it to run the entire failure matrix. Provider authentication errors are not expected failures and must stop testing.

Testing hooks, not user features:

- `PI_SUBAGENTS_CHILD_NO_DISCOVERY=1` adds `--no-extensions` to children.
- `PI_SUBAGENTS_CHILD_EXTENSIONS` is a list of additional child extension paths. The harness uses it for narrowly enabled dialog/hold/failure tools and provider-payload faults.
- `PI_SUBAGENTS_FINGERPRINT_MAX_BYTES` and `PI_SUBAGENTS_FINGERPRINT_MAX_MS` lower the inspect fingerprint budget for tests. `0` milliseconds means unknown immediately. Exceeding either budget reports `unknown`, never `clean`.
- `PI_SUBAGENTS_LOG_TOOLS` enables child tool-call input logging.
- The `subagents:test-takeover-claimed` extension-bus event lets a harness extension delay acknowledgement after the durable takeover claim to test cross-process cancellation ordering.

The optional `defaultProjectTrust: "always"` check in a separate agent directory is not part of the current trust scenario. A taken-over child keeps its reservation until its process exits; the recovery scenario checks that release.
