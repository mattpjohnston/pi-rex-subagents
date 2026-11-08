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

Machine-wide admission, reservations, checkout write exclusion, ceilings, background delivery, inbox/control, nesting, dismissal and Rex actions belong to later phases. Phase 1's admission function intentionally does nothing. Do not use this unfinished phase to coordinate concurrent writers on a shared checkout.

## Durable state

State defaults to `getAgentDir()/subagents`, overridable with `PI_SUBAGENTS_STATE_DIR`. Directories are private (`0700`), files private (`0600`). Each `runs/<run-id>/` contains:

- `run.json`: a versioned, boundary-validated record containing label/task path, canonical cwd and checkout root, access, resolved requested settings before thinking clamp, effective settings, continuation reference, parent session/run/depth, immutable launch Rex IDs, current location, artifact paths, lifecycle, process observation, waiting source/kind/title, diagnostics and timestamps. Ownership is not a record field.
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
```

The harness uses real Pi and Rex, independent temporary state/session directories and only disposable Rex sessions it created. Outputs are archived under ignored `.harness-runs/`. Every run checks hashes of global settings, the installed subagent extension and the trust store, plus colon-separated `HARNESS_GUARD_FILES`. Teardown removes only this run's Rex sessions and scratch directory, including on failure. The trust scenario requires the caller's normal `ask` policy and verifies the selected **session-only** option before sending Enter; it must not save a trust decision.

`HARNESS_MODEL` selects the test model, defaulting to `openrouter/nvidia/nemotron-3.5-lightning:free`. The launch scenario exercises inheritance and an explicit provider/model selection. `HARNESS_FAILURE_CASE` optionally selects one failure case during debugging; omit it to run the entire failure matrix. Provider authentication errors are not expected failures and must stop testing.

Testing hooks, not user features:

- `PI_SUBAGENTS_CHILD_NO_DISCOVERY=1` adds `--no-extensions` to children.
- `PI_SUBAGENTS_CHILD_EXTENSIONS` is a list of additional child extension paths. The harness uses it for narrowly enabled dialog/hold/failure tools and provider-payload faults.
- `PI_SUBAGENTS_LOG_TOOLS` enables child tool-call input logging.
- The `subagents:test-takeover-claimed` extension-bus event lets a harness extension delay acknowledgement after the durable takeover claim to test cross-process cancellation ordering.

The optional `defaultProjectTrust: "always"` check in a separate agent directory is not part of the current trust scenario. Retained reservations after takeover are tested in the admission phase, not phase 1.
