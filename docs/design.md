# Design

How pi-rex-subagents works, and why. This is for people changing the code. The [README](../README.md) covers using it.

## Who does what

A subagent is an ordinary Pi process running in a Rex tab.

- The parent model decides what to run: the tasks, models, worktrees, order, and how to review the results.
- Pi runs each subagent's conversation and tools, and saves its session.
- Rex runs the terminals and handles tabs, focus, and process status.
- The extension starts subagents, decides when each may start, tracks each run until it ends, keeps writers out of each other's way, and gets the result back to the parent.

The extension has no roles, workflows, worktree management, or automatic retries. A label is only a tab name. Any subagent with a shell can write files, whatever its task says.

## Tabs

Each subagent opens as a new tab in the parent's Rex session, named after its label, without taking focus. The extension never splits panes or switches your view. You can move a subagent's tab or split it with Rex's own controls. The extension tracks each subagent by its Rex block ID, which doesn't change when it moves, and looks up its current tab when it needs it.

Subagents go in the parent's session rather than a session of their own. Rex shows status dots on tabs, not on session names, so a subagent waiting for you shows up right under its parent. A session per parent also multiplies quickly.

The extension starts each subagent with `rex window new ... --shell none -- pi ...`, so no shell parses the command. Rex can't set environment variables for a new tab, so the few values a subagent needs are passed as `/usr/bin/env K=V` in its arguments. Any user on the machine can read those with `ps`, so they are never secrets. Provider credentials stay in Pi's own storage.

### Closing finished tabs

When a subagent completes and its process has exited, the parent closes its tab after `closeCompletedAfter` seconds (60 by default, set in `limits.json`).

Rex doesn't report which session the app is showing, so the extension treats a tab as viewed while it is the selected tab in its session. It never closes a viewed tab, and waits 5 more seconds after you switch away so that tabbing past one doesn't close it. The check can only err towards keeping a tab. A tab you're looking at is always the selected one. A tab left selected in a session you've walked away from just stays open longer.

A tab whose label no longer matches the subagent's label is kept. `rex/keep.lua` (the `subagents_keep` action) and `/subagents keep` add `📌` to the label, and renaming or sharing the tab changes it too. The label is the only record of this, so you can see it in the sidebar and undo it by removing the pin.

Once Rex confirms a finished tab is gone, the run record says so and the parent stops asking Rex about it. This survives a reload.

Only completed subagents that were never taken over close automatically. Failed, cancelled, and taken-over ones keep their tabs so you can see what happened. The parent's Pi does the closing, so if the parent has exited, its subagents' tabs stay until a `/subagents clear`.

## Runs

Each run has a private directory, `runs/<run-id>/`, in the state directory:

- `run.json` is the run record: settings, repository root, access, Rex IDs, state, process state, and the parent's Pi session ID. The parent writes it before starting the subagent, and every read validates it.
- `claim` records who decided how the run ended: `result`, `taken_over`, or `cancelled`.
- `lock` is a directory held while anything writes the claim or accepts a message.
- `result.json`, `task.md`, `events.jsonl` (what the subagent's side of the extension saw), `inbox/`, and `session/` (the subagent's full Pi session).

A run goes from `admitting` to `starting` to `running`, then ends `completed`, `failed`, `aborted`, `incomplete`, `taken_over`, or `cancelled`. Process state is tracked separately as `live`, `exited`, `unresolved` (still alive after its shutdown grace), or `unknown` (Rex unreachable). A finished answer doesn't mean the process has exited.

### The claim

Three things can end a run: the subagent finishing, you taking it over, and the parent cancelling it. Each writes its outcome to a temporary file, syncs it, and hard-links it to `claim`. Linking fails if `claim` already exists, so the first one wins, and a crash can't leave an empty claim. Each holds the run's lock while it does this. The lock directory records its holder's process ID and start time, so another process can remove it once that holder is gone.

- **Finishing.** When Pi reports the agent has settled, the subagent's side of the extension takes the lock and reads the claim. If the run was cancelled, it exits. If it was taken over, it stays running and reports nothing. Otherwise it first deals with anything still owed to it: outcomes from its own subagents and accepted messages. It sends those to the model in one turn and waits. It writes the result and claims `result` only once nothing is owed, nothing is unread, and none of its own subagents are still running.
- **Takeover.** `/subagent-takeover` claims `taken_over` before it tells you anything. If the run already ended, it says so and does nothing. After a `/reload` the subagent reads the claim again, so a taken-over session still won't report or exit.
- **Cancelling.** The parent claims `cancelled` before signalling the subagent. It leaves a taken-over subagent alone. A subagent that hangs after claiming its result can still be closed, and its result stays.

Only a real quit may record a failure on shutdown, because Pi sends the same shutdown event for reloads and session switches. A subagent refuses to switch sessions before its run has ended.

### Finishing for real

A run counts as finished only when there's a valid result and Rex confirms the process exited. After the result, the parent waits up to 10 seconds for the exit. If the process is still alive, the parent hands back the answer marked unresolved and keeps the repository reserved. Cancelling waits up to 30 seconds, because a subagent interrupted in the middle of a tool call can take that long to exit. Startup has a 60-second limit, and tasks have none. The extension never retries a Rex launch after a timeout, because the first attempt may have worked.

Rex's `done` status is only display. The parent follows exits and status through one `rex events --all --json` stream, filtered to its subagents' block IDs, and checks each block directly when the stream drops. Rex exits with code 3 when a block is gone and 4 when Rex can't be reached. On 4, the extension frees nothing.

## Access modes

`read` starts Pi with `--no-extensions --no-mcp --tools read,grep,find,ls,git_read`, plus this extension. `--tools` alone isn't enough, because MCP tools stay callable without `--no-mcp`. At every session start, including after `/reload`, the subagent checks its active and loadable tools, and fails the run before the model does anything if it finds a tool outside those five.

`git_read` runs Git with an argument list and no shell. It allows `log`, `show`, `blame`, `diff`, `ls-files`, `rev-parse`, `status`, `shortlog`, and `grep`. It refuses options that write files or run commands, including abbreviated long options and `-O` bundled with other short options. A repository's own config can also make Git run commands, so `git_read`:

- reads attributes from the empty tree (`--attr-source`), with an empty attributes file and no system attributes, which stops filter and diff drivers;
- turns off hooks, fsmonitor, external diff, text conversion, signature display, optional locks, and fetching missing objects from a remote;
- removes every inherited `GIT_*` environment variable.

Each rule has a test that plants a command in a real repository and checks it doesn't run.

`inspect` is the normal setup with `--exclude-tools edit,write`, checked at every session start. It keeps the shell, MCP, and extensions, and counts as a reader. Before launch and after exit, the parent records the repository's state:

- In a Git repository: HEAD, every ref, the staged entries and index flags, the repository's config, hooks, and `info/` files, and a hash of every file under the root, including untracked and ignored files.
- Anywhere else: a hash of every file under the directory.

The result says `clean`, `changed` with the changed paths, or `unknown` if the size or time limit ran out. This never changes whether the run succeeded. The hashes are of file contents because HEAD plus `git status` misses writes to ignored files, `skip-worktree` edits, and new refs. They can't see writes outside the repository or changes undone before the subagent exits.

`write` is the normal Pi setup.

Subagents use Pi's normal trust prompts. The extension watches for the trust event so it can tell you a subagent is waiting, and always answers "undecided", which leaves the decision to Pi and you.

## Deciding when a subagent starts

Before a subagent starts, the extension decides whether it may run now or must wait. The extension calls this admission. It works machine-wide, through files, with no background service. One lock directory serializes decisions. Each waiting launch holds a numbered ticket. Each running subagent belongs to one reservation for its repository.

A repository is identified by its real path: the Git working-tree root, or the directory itself. Two paths conflict when one contains the other, so a repository nested inside another conflicts with it. Separate worktrees don't conflict.

| Situation                                              | Rule                |
| ------------------------------------------------------ | ------------------- |
| `read` and `inspect` subagents in one repository       | Run together        |
| A `write` subagent and anything else in one repository | The later one waits |
| `write` subagents in separate worktrees                | Run together        |

Waiting launches go in order, so a newer reader never jumps an older waiting writer. Repository conflicts are checked before the cap on running subagents, and only launches waiting for a free slot hold a place in that line. A launch blocked on a repository doesn't take a slot it can't use.

The `active` cap counts running subagents across every parent, including ones you've taken over. Per-provider caps work the same way. There is no separate cap on writers, since the repository rule already keeps them apart.

A subagent's reservation ends when Rex confirms its process exited. If Rex can't be reached, the reservation stays. A taken-over subagent keeps its reservation until its process exits.

While a `write` subagent holds a repository, the parent's own `edit` and `write` calls inside it are refused, including an edit in the same message as the launch. `bash` is never refused, because there's no way to know what a command will touch. This keeps cooperating tools apart. It isn't a lock.

### Nested subagents

`write` and `inspect` subagents can start their own subagents, down to `depth` levels below a session you started (2 by default). At the limit, and in `read` subagents, the `subagent` and `subagent_control` tools aren't registered. An `inspect` subagent's own subagents default to `inspect`, and it can't start a `write` one. Results go only to the immediate parent.

Nesting needs three extra rules, or subagents deadlock waiting for each other:

- A subagent working in its parent's repository joins the parent's reservation instead of queueing behind unrelated runs.
- A launch that would complete a cycle of runs waiting on each other is refused, and the refusal names the runs.
- A run waiting on its own subagents is "parked". It doesn't count against the caps, and it must get a slot back before its next model call. A parked run that's ready ahead of newer launches goes first. Your own actions, such as taking over, typing in its tab, or changing its model, count at once, even over a cap.

Joining a reservation waits for tool calls the parent already started, so an `edit` or `bash` that's running can't overlap the new subagent. It doesn't wait for a pending `subagent` call, or for a call that contains one, such as a codemode script that starts a subagent. Each of those finishes only after its subagent does, so waiting on it would deadlock. Pi reports every call a codemode script makes as a separate tool call, so an `edit` or `bash` inside the script still holds the join.

While a parent has a live subagent in its reservation, its own `edit` and `write` in that repository are refused.

The subagent's side of the extension records what it's doing in `activity` in the run record: whether it's parked, whether it's ready to wake, and which tool calls are running. A subagent never waits for a slot while holding a lock, so you can always take it over.

A busy subagent keeps its own subagents' outcomes on disk until it settles. Then it sends them, and any accepted messages, to the model in one turn. Delivery counts once the outcome's marker is in a saved message. Nested results never use the top-level `subagent-results` message. If a subagent's parent has gone, nothing is delivered and the files stay on disk.

Cancelling a run also cancels the runs below it, except ones you've taken over and anything below those. A cancelled ancestor makes waiting launches under it give up and new ones get refused. If Rex replies to a launch after its ancestor was cancelled, the launcher closes that new tab. Listings show each run under its parent, indented.

## Background results

A background launch returns its run ID once the run is admitted or queued. Its outcome is ready once its claim exists and its process has exited, or once its shutdown grace has passed with the process still alive. A takeover is ready at once, so the parent hears about it without waiting for your session to end. What's ready is worked out from the run records and the parent's session file, not kept in memory.

Results are batched. While the parent is busy, nothing is sent. When it finishes its turn, every ready result goes in one message. When it's idle, the extension waits 3 seconds for others finishing around the same time. Each batch is one `subagent-results` message listing its run IDs, capped at 50 KB or 2,000 lines in total. Results that don't fit are listed by run ID, outcome, and result path.

A result counts as delivered when a `subagent-results` message naming it is on the parent's current branch, including messages folded into a compaction summary. At every session start and `/tree` move, the extension sends any ready result not on the current branch. So after `/tree` to a branch without the delivery, it's sent again there. If the branch ends with a delivery the model never answered, as a crash between saving it and the model's turn would leave, the extension starts one turn with a short note instead of sending the results again.

What happens to background subagents when the parent changes session:

| Parent action                        | Background subagents                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/reload`                            | Keep running. The reloaded extension picks them up again.                                                                                                                |
| Quit                                 | Cancelled. Undelivered results are added to the session without starting a turn.                                                                                         |
| `/new`, `/resume`, `/fork`, `/clone` | Pi asks first if any are running or queued, or results are undelivered. If you confirm, they're cancelled and the results are added to the old session before switching. |
| A crash                              | Nothing. Reservations stay until the extension sees the processes have gone.                                                                                             |

No session change cancels a subagent you've taken over.

## Parent controls and messages

`subagent_control` has `list`, `cancel`, and `message`. There's no "wait" operation. `list` shows at most 30 runs: the parent's subagents and theirs. `cancel` takes the same path as `/subagents cancel`.

A message is a file, `inbox/<id>.json`, holding the ID, run ID, text, sender (the parent's Pi session ID), and time. Its answer is a second file, `<id>.ack.json`, which says `accepted` (with when it was sent to the model, once it is), `consumed`, or `refused` (with the claim that caused it).

The subagent checks its inbox every 250 ms. It accepts a message only if the run hasn't ended, checked under the run lock, so a message can't slip in as the run finishes. It sends an accepted message with `pi.sendUserMessage`, as steering while the model is working or as a new prompt while it's idle, with the message ID in the text. It never types into the terminal, which could answer an open dialog. A message counts as consumed once its ID appears in a saved user message. Pi emits `message_end` before saving the message, so the check happens afterwards.

The parent waits up to 10 seconds for an answer and reports `accepted`, `refused`, or `unacknowledged`. A message file on its own never counts as delivered. If you take over a subagent, the parent's `taken_over` result lists messages it had accepted but not yet read.

## Rex actions

`rex/next_waiting.lua` registers `subagents_next_waiting`. It reads the records of running subagents, picks the one that has waited longest for you, and selects its tab. `/subagents go next` runs the same script. It uses the run records rather than Rex status, because Pi's trust prompt doesn't show as a Rex status. With 48 running subagents it takes about 20 ms. Each time a subagent starts waiting, it writes one OSC 9 desktop notification to its own terminal.

`rex/keep.lua` registers `subagents_keep`, which pins or unpins the selected tab.

## Models

`models/` holds two Python models that try every ordering of their steps:

- `admission.py` covers reservations, parking, cycle refusal, and caps.
- `protocol.py` covers one run's lock, claim, inbox, finishing, takeover, and cancellation, including a parent crash.

Each also runs earlier versions of the rules, labelled `e18` and `e19`, which had known bugs. A script fails unless the old rules fail where expected and the current rules pass. CI runs both. Vitest tests drive the TypeScript admission code with states generated by `admission.py`, and compare the inbox and finishing decisions against all 461 states `protocol.py` can reach.

The models treat each step as indivisible. Races inside a step, Rex and Pi failures, and `/tree` moves are covered by the end-to-end tests instead.
