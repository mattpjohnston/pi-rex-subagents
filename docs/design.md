# Design

This document describes how pi-rex-subagents works and why. It covers the whole design, including parts the first release does not build yet. Those parts are marked **(later)**.

## Boundaries

Delegation stays a real, fresh Pi process running directly in a Rex terminal.

- The parent chooses tasks, instructions, models, worktrees, sequencing, and review.
- Pi owns the child conversation, tools, model interaction, and saved session.
- Rex owns terminals, navigation, layout, process observation, and status display.
- The extension owns launch options, admission, the child lifecycle, checkout coordination, and result delivery.

There is no role catalogue, no workflow engine, no worktree manager, and no automatic retry or resume. A label never selects policy. Any child with a shell can write, whatever its task is called.

## Placement

Each child opens as a background tab (`--focus=false`) in the parent's own Rex session, named after its label. The extension never switches your view and never splits panes. You can move or split children with Rex's own controls. The extension tracks each child by its stable Rex block ID and resolves its current location when it needs it, so moving a tab never changes ownership.

Child tabs sit in the parent's session, not a dedicated one, for two reasons. Rex draws status on tabs, not on session headings, so a waiting child should appear right under its parent. And a session per parent multiplies sessions quickly.

Children are launched with direct argv (`rex window new ... --shell none -- pi ...`), never by typing into a shell. Rex has no environment option, so the few values passed to a child go through `/usr/bin/env K=V` in its argv. Anyone on the machine can read those with `ps`, so they are never secrets. Provider credentials stay in Pi's own storage.

## Run record, claim, and lock

Each run has one directory under `runs/<run-id>/` in the state directory, with private permissions. It holds:

- `run.json`, the run record. It has the resolved launch settings, checkout root, access, Rex IDs, lifecycle state, process observation, and the parent's Pi session ID. The parent writes it before launching the child. It is parsed and validated on every read.
- `claim`, which decides who owns the outcome. Its content is `result`, `taken_over`, or `cancelled`.
- `lock`, a directory that settlement, takeover, cancellation, and message acceptance hold while they claim.
- `result.json`, `task.md`, `events.jsonl` (the child reporter's events), `inbox/`, and `session/` (the child's full Pi session).

The lifecycle is `admitting`, then `starting`, then `running`, then one outcome: `completed`, `failed`, `aborted`, `incomplete`, `taken_over`, or `cancelled`. Process state is separate: `live`, `exited`, `unresolved` (still alive after a grace period), or `unknown` (Rex unreachable). A settled result does not prove the process has exited.

**One claim per run.** Settlement, takeover, and cancellation each write their outcome to a private temporary file, sync it, and hard-link it into place as `claim`. The link fails if a claim exists, so the first link wins, and a crash cannot leave an empty claim behind. Each of the three holds the run lock while it claims. The lock directory is published atomically with its holder's process ID and start time, so any process can recover it once the holder is gone, under the admission lock.

- **Settlement.** On `agent_settled`, the child reporter takes the admission lock, then the run lock, and reads the claim. Under `cancelled` or `result` it exits. Under `taken_over` it stays alive and publishes nothing. With no claim, it accepts pending inbox messages, sends unsent accepted messages together in one turn, and publishes nothing. Sent-but-unconsumed messages also block publication: Pi starts work queued from settlement only after all settled handlers return. Otherwise it writes the result, claims `result`, and shuts down. Descendant outcomes and parking will extend marked places in this same decision table when nesting ships.
- **Takeover.** `/subagent-takeover` claims `taken_over` before it acknowledges anything. If settlement or cancellation already won, takeover fails visibly. A reloaded child reads the claim at load, so a reload after takeover still does not publish.
- **Cancellation.** The parent claims `cancelled` before it signals the child. If the claim says `taken_over`, it leaves the child alone. A child that hangs after claiming `result` can still be closed, and its outcome stays unchanged.

Only `session_shutdown` with reason `quit` may publish a failure result. Pi emits the same event for reload and session switches. A managed child refuses to replace its session before its outcome is claimed.

**Completion needs a validated result and confirmed process exit.** After a result, the parent waits a bounded shutdown grace (10 seconds) for the exit. If the process is still alive, the parent returns the answer marked as an unresolved process and keeps the checkout reserved. Cancellation waits up to 30 seconds, because a child interrupted in the middle of a tool call can take that long to exit. Startup has a deadline, and tasks have none. A Rex launch is never retried after a timeout, because the first attempt may have succeeded.

Rex's `done` status is display state, not a result. The parent follows exits and status through one `rex events --all --json` stream, filtered by its children's block IDs. A session-scoped stream would lose a child you moved to another session. A block liveness check covers the gaps. Rex exit code 3 means the block is gone. Exit code 4 means Rex is unreachable, and then nothing is released.

## Access modes

**`read`** launches Pi with `--no-extensions --no-mcp --tools read,grep,find,ls,git_read`, plus the extension as the only extension. `--tools` alone is not enough, because MCP tools stay callable without `--no-mcp`. At every `session_start`, including after `/reload`, the reporter checks the active and loadable tools. If anything beyond the five allowed tools is present, it fails the run before the model acts.

`git_read` runs Git with an argument array and no shell. It allows `log`, `show`, `blame`, `diff`, `ls-files`, `rev-parse`, `status`, `shortlog`, and `grep`. It refuses the options that write files or run commands, including unique prefixes of long options and `-O` inside a bundle of short options. A repository's own config can still run commands through Git, so `git_read` also does the following:

- It reads attributes from the empty tree (`--attr-source`), with an empty attributes file and no system attributes. That stops filter and diff drivers.
- It disables hooks, fsmonitor, external diff, text conversion, signature display, optional locks, and lazy fetching from promisor remotes.
- It removes every inherited `GIT_*` variable.

Each of these rules has a test that plants the command in a real repository and shows it does not run.

**`inspect`** is the normal environment with `--exclude-tools edit,write`, checked at every `session_start`. It keeps the shell, MCP, and trusted extensions. It is admitted as a reader. Before launch and after exit, the parent fingerprints the checkout:

- For Git, it records HEAD, every ref, the staged entries and index flags, the repository's config, hooks, and `info/` files, and a content hash of every file under the root, including untracked and ignored ones.
- Elsewhere, it records a content hash of every file under the root.

The result's `checkout` field is `clean`, `changed` with the paths, or `unknown` when a size or time budget runs out. The field never changes the outcome. The fingerprint hashes contents because HEAD plus `git status` misses writes to ignored files, `skip-worktree` edits, and new refs. It cannot see writes outside the checkout or changes reverted before exit.

**`write`** uses the normal Pi environment.

Children use Pi's normal project-trust resolution. The reporter observes the `project_trust` event and returns `undecided`, so a child waiting on the trust prompt can raise a notice. The extension never makes the decision itself.

## Admission

Admission is machine-wide, through files, with no daemon. A lock directory serializes decisions. Each waiting launch holds one ticket with a sequence number. Each live child is a member of one reservation for its checkout.

Checkouts are identified by canonical path: the Git working-tree root, or the real directory. Two checkouts conflict when one contains the other, so a nested repository conflicts with its outer checkout. Sibling worktrees do not conflict.

| Situation                                  | Rule                |
| ------------------------------------------ | ------------------- |
| Readers and inspectors on one checkout     | Overlap             |
| A writer and anything else on one checkout | The later one waits |
| Writers in separate worktrees              | Overlap             |

Admission is FIFO, so a newer reader never passes an older waiting writer. Checkout conflicts are checked before capacity, and only tickets waiting purely for capacity hold a place in the capacity line. A ticket waiting on a checkout does not hold a slot it cannot use.

The active ceiling counts live children across every parent, including children a human has taken over. Optional per-provider ceilings work the same way. There is no writer ceiling, because checkout exclusion already keeps writers apart.

A membership ends when Rex confirms the child's process exited, either because the block is gone or because the block's process has exited. If Rex is unreachable, the membership stays. A taken-over child keeps its membership until its process exits.

The parent's own `edit` and `write` calls are refused inside a checkout a live child writer holds, including an edit in the same message as the launch. `bash` is never refused, because its targets cannot be known in advance. This is coordination for well-behaved tools, not a lock.

### Nesting

A `write` or `inspect` child can launch below the configured depth (default 2, counting the unmanaged parent's children as layer 1). Tools are not registered at the limit or in a reader. Inspectors default to inspect and cannot launch writers. Records identify the immediate parent run/session and root parent session; only the immediate parent receives results. Three rules keep admission free of deadlocks:

- A descendant on an overlapping checkout joins its ancestor's reservation instead of queueing behind runs outside it.
- A launch that would close a wait cycle is refused, naming the runs in the cycle.
- A run parked on its descendants does not count against the ceilings, and it goes back through admission before its next model call.

The core is checked differentially against the model, and a disk-backed test checks the live snapshot shape: exited ancestry, parked members, human-owned members, detached outcomes, and queued tickets. Model-driven wakeups wait for capacity ahead of newer tickets. Takeover, human input, and model changes clear parking immediately, even over a ceiling.

The reporter owns `activity` in the run record: parking, wake readiness, foreground calls, and started tools. Admission serializes activity updates with parent lifecycle writes, preserving newer reporter fields. Foreground calls park before waiting; the last sibling return reacquires capacity before Pi can make its next model call. Settlement parks while descendants or accepted messages remain. A settled reporter never waits for capacity while holding a lock or a settlement callback: polling retries the wake, leaving takeover available.

**Join amendment.** Joining waits for every ancestor member's started tool except `subagent`, including non-launch siblings in the same assistant message. Waiting for the launching or sibling `subagent` would deadlock foreground nesting: it cannot end until its nested child finishes. Bash and every other started tool still hold the join. The member's edit/write guard sees pending launches in the assistant message and live descendant members. Bash remains an accepted coordination gap.

**One nested delivery owner.** Busy children retain background outcomes on disk without queueing a turn. At settlement, or polling after a parked settlement, the reporter reads immediate descendants and inbox messages under admission then run lock. Pending outcomes and unsent accepted messages go together in one `sendUserMessage` turn, after wake admission. Persisted `[subagent outcome <id>]` markers prove delivery on the active branch; sent-but-not-yet-persisted outcomes block publication. Foreground tool results carry the run ID and already count as delivered. Nested outcomes never use the unmanaged parent's `subagent-results` path. Takeover is ready immediately without waiting for the human's process exit. Cancellation, startup failure, and result/exit outcomes use the same path. With no waiting deliveries, sent inbox messages block publication, live descendants cause parking, and only then may the reporter claim a result. Exited immediate parents receive nothing; artifacts stay on disk.

Cancellation claims the selected run and descendants under admission then each run lock, skipping human-owned subtrees. Claimed ancestors invalidate waiting tickets and refuse launches. Once Rex replies to an in-flight launch, the launcher rechecks claims and closes the exact new block if cancellation won. Observation lists the tree parent-first with indentation.

The protocol model covers one run, not a descendant graph. Its exhaustive differential still checks the unchanged one-run table. Explicit descendant-table tests and real harness schedules check coalescing, busy outcomes, parking, and publication ordering.

## Background delivery

A background launch returns its run ID once the run is admitted or queued. Its outcome becomes pending once its claim exists and its process exit is confirmed, or once the shutdown grace ends with the process still alive. Pending state lives on disk, derived from the run records and the parent session.

Results are coalesced. While the parent is busy, nothing is sent. When it settles, every pending outcome goes in one message. While it is idle, the extension waits about a second for siblings that finish close together. Each delivery is one custom message with type `subagent-results`, listing its run IDs, capped at 50 KB or 2000 lines as a whole. Entries that do not fit become run ID, outcome, and result path.

An outcome counts as delivered when a `subagent-results` entry naming it is on the parent's active branch. Entries a compaction summarized still count. On every `session_start` and `session_tree`, the extension delivers any pending outcome that is not on the active branch, so `/tree` to a branch without the delivery sends it again there. If the branch ends with a delivery that no response follows, as a crash between writing it and its turn would leave, reconciliation starts one turn with a short note instead of resending.

Parent transitions:

| Transition                           | Background children                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/reload`                            | Keep running. The reloaded runtime reattaches and reconciles.                                                                                                                      |
| `quit`                               | Cancelled. Undelivered outcomes are appended to the session without starting a turn.                                                                                               |
| `/new`, `/resume`, `/fork`, `/clone` | Refused while children are live or queued or outcomes are undelivered, unless you confirm. On confirmation, children are cancelled and outcomes appended to the old session first. |
| Crash                                | Nothing. Reservations stay until liveness finds the child gone.                                                                                                                    |

Taken-over children are never cancelled by a transition.

## Parent control and inbox

The `subagent_control` tool has `list`, `cancel`, and `message`, with no model-facing wait operation. Listing is bounded to 30 and scopes by ancestry. Cancel uses the same claim-and-signal path as `/subagents cancel`, refuses human-owned subtrees, and can close a hung result winner after its shutdown grace without changing its outcome.

Each message is a private, atomically replaced `inbox/<message-id>.json` with `id`, `runId`, `text`, `sender` (the parent Pi session ID), and `createdAt`. Before acknowledgment its state is implicitly `written`. The companion `<message-id>.ack.json` is one union: `accepted` with `acceptedAt` and nullable `sentAt`, `consumed` with those timestamps and `consumedAt`, or `refused` with the winning `claim` and `refusedAt`. Every ack includes `messageId` and `runId`. The model's `sent` state is an accepted ack with non-null `sentAt`.

The reporter polls every 250 ms rather than relying on filesystem notifications surviving atomic rename. Acceptance, dispatch, consumption, and claims take admission before run, so they can recover a confirmed dead lock holder in the same order. Acceptance rechecks the claim and refuses if any claim exists. Dispatch uses `pi.sendUserMessage` with the ID in the text, `deliverAs: "steer"` while working, or a prompt while idle. It never types into the terminal. Consumption requires finding that marker in a persisted user message. Pi emits `message_end` before appending to its session, so the reporter checks the branch after the event returns, during polling, and at settlement.

The parent waits at most 10 seconds for an ack. Writing the message alone is never called delivery. Takeover saves a snapshot of accepted, unconsumed messages alongside the claim so the parent's `taken_over` outcome can list them, even if they are consumed later in the human-owned conversation.

## Later additions

- **Rex additions.** A `subagents.next_waiting` Rex action that jumps to the oldest waiting child, and an OSC 9 desktop notice when a child starts waiting.

## Models

`models/` holds two exhaustive Python models of these rules.

- `admission.py` covers reservations, parking, cycle refusal, and ceilings.
- `protocol.py` covers one run's lock, claim, inbox, settlement, takeover, and cancellation, including a parent crash.

Each explores every interleaving of its steps. Each also runs earlier design rules beside the current ones, labelled `e18` or `e19` in the code. A script exits nonzero unless the earlier rules fail where expected and the current rules pass. CI runs both models. Vitest differential tests drive the TypeScript admission core with generated states and compare inbox/settlement decisions against all 461 reachable current protocol states, including 18 sent-but-unconsumed settlements. Changing the wait rule to publish reproduces the model's unsafe `e19` mistake and fails the differential test.

The models make each step atomic. Races inside a step, Rex and Pi failures, and branch navigation are covered by the real Pi and Rex harness instead.
