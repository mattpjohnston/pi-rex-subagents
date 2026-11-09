# pi-rex-subagents

A [Pi](https://pi.dev) extension that delegates work to fresh Pi sessions running in [Rex](https://www.superlogical.com/rex) terminal tabs. Each child is a normal interactive Pi that you can watch, steer, or take over. The parent gets back a validated result, not a scrape of the terminal.

The extension owns launch options, admission, the child lifecycle, checkout coordination, and result delivery. Pi owns the child conversation and tools. Rex owns terminals and navigation. The parent model and its instructions own the workflow: which tasks to run, with which models, in which worktrees, and how to review the results.

## Status

The first release covers:

- Several children at once, foreground or background.
- Machine-wide admission. Readers share a checkout, a writer gets it alone, and an active-children ceiling applies across every parent on the machine.
- `read` children restricted to file tools and an allowlisted `git_read`.
- `inspect` children that keep a shell and MCP but report afterwards whether the checkout changed during the run.
- Background results pushed into the parent session, coalesced, and reconciled after reloads and crashes.
- Parent controls to list runs, cancel a stuck child, and send acknowledged stop or hold orders without typing into its terminal.
- Nested write/inspect delegates with shared reservations, parked capacity, and immediate-parent result delivery, to a configured depth (default 2).

These are designed but not built yet:

- A Rex action that jumps to the next waiting child.
- A desktop notice when a child waits.

See [docs/design.md](docs/design.md) for the full design.

## Requirements

- Pi 1.5.0 or later, with the provider credentials your children will use already stored by Pi.
- A local Rex server. The parent Pi must run inside a Rex terminal, because children open as tabs in the parent's Rex session.
- Git, if you want checkout identity and `git_read` to understand repositories.

## Install

Install it as a Pi package:

```sh
pi install git:github.com/mattpjohnston/pi-rex-subagents
```

Or try it for one session:

```sh
pi -e git:github.com/mattpjohnston/pi-rex-subagents
```

The extension registers a tool named `subagent`. Remove or disable any other extension that registers the same tool name before you install this one.

## Use

Ask the parent to delegate. It calls `subagent` with:

| Input                           | Meaning                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `task`                          | The complete task. The child does not see the parent's conversation.                       |
| `label`                         | Optional tab name. It never selects policy.                                                |
| `cwd`                           | Working directory. Defaults to the parent's.                                               |
| `access`                        | `read`, `inspect`, or `write` (default). See below.                                        |
| `background`                    | `true` returns a run ID at once. The result arrives later as a message.                    |
| `continueFrom`                  | Run ID of an exited earlier run. The child starts from a fork of that run's saved session. |
| `provider`, `model`, `thinking` | Overrides. Omitted settings inherit the parent's.                                          |

Each child opens as a background tab in your Rex session, named after its label, without taking focus. Open the tab to watch it. Enter steers the child and Escape interrupts it, as in any Pi session.

A foreground call blocks until the child finishes, and blocks steering of the parent until then. Several calls in one message run in parallel. Use background for long work, or for work you may want to talk to the parent about while it runs.

Ask children for a short final report, and have bulk output written to a file the report names. Each result the parent sees is capped at 50 KB or 2000 lines, with the path to the child's full session.

### Access modes

- **`write`** runs the normal Pi environment. It is admitted as a writer, alone on its checkout.
- **`read`** has only `read`, `grep`, `find`, `ls`, and `git_read`. Extensions, MCP, and the shell are off, and the extension checks the callable tool set before the task starts. `git_read` runs a small set of Git subcommands with hardening against commands that a repository's own config could run. It is a tool restriction inside a trusted process, not an operating-system sandbox.
- **`inspect`** runs the normal environment without the `edit` and `write` tools, so it keeps a shell and MCP. It is admitted as a reader. The extension fingerprints the checkout's contents before and after the run, and the result says `clean`, `changed` (with the paths), or `unknown`. This is a declaration checked afterwards, not enforcement.

### Commands

- `/subagents` lists this parent's runs, waiting children first.
- `/subagents all` lists live children of every parent on the machine.
- `/subagents go <label>` switches Rex to the child's tab, wherever you have moved it.
- `/subagents cancel <label|run-id>` cancels a queued or running background run.
- `/subagents clear` closes the tabs of children that completed and exited.
- `/subagents dismiss <label|run-id>` closes one exited child's tab.
- `/subagent-takeover`, typed in a child's tab, makes you the owner of that child. It stops reporting to the parent and does not exit when its work settles.

Closing a child's tab never deletes its result, session, or records.

When a child stops for a human, for example on a dialog or Pi's project-trust prompt, the parent shows a notice naming the child and the `/subagents go` command.

### Parent controls

The parent model has one `subagent_control` tool:

| Operation | Inputs          | Use                                                                                                                                                                                                |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`    | No other inputs | This parent's runs, bounded to 30, with access, state, queue reason, checkout, last Rex status, human wait, and elapsed time.                                                                      |
| `cancel`  | `runId`         | Cancel queued or live work before replacing a stuck agent. A taken-over child is refused. A process hanging after its result's 10-second shutdown grace can be closed without changing the answer. |
| `message` | `runId`, `text` | Send a correction or stop/hold order, as steering during work or a prompt while idle. Not for chaining new work; launch another child for that.                                                    |

`message` returns `accepted` only after the child acknowledges it under the same lock as settlement and takeover. It returns `refused` with a reason, or `unacknowledged` after 10 seconds. An unacknowledged message may still be accepted later; it is not proof of delivery or refusal. The message ID appears in the child's saved user message, and settlement waits for accepted messages to be consumed before publishing. Messages never answer an open dialog. A takeover outcome lists accepted messages that were not consumed when the human took ownership.

Write and inspect children get `subagent` and `subagent_control` below the depth limit. Read children never get them. Inspect children default nested launches to inspect and cannot launch writers. Members cannot edit/write their checkout while a live descendant shares their reservation; bash is not blocked.

### Limits

Admission reads `limits.json` in the state directory on every decision, so edits apply to the next launch:

```json
{ "active": 4, "depth": 2, "providers": { "openrouter": 2 } }
```

- `active` is the most live children across every parent on the machine. The default is 4.
- `providers` optionally caps children per provider.
- `depth` counts layers below the unmanaged parent. The default is 2; 1 disables nesting. Parked children retain reservations but release capacity while waiting for descendants, then reacquire a slot before model work resumes. Human actions count immediately, even over a ceiling.

A missing file means the defaults. A malformed file blocks admission with an error naming the file.

The state directory is `subagents/` in Pi's agent directory (`~/.pi/agent/subagents` by default). Override it with `PI_SUBAGENTS_STATE_DIR`. Find `pi` and `rex` somewhere other than `PATH` with `PI_SUBAGENTS_PI` and `PI_SUBAGENTS_REX`.

### Project trust

Children use Pi's normal project-trust decisions for their working directory. The extension never approves a folder. If you keep worktrees under one root, choose Pi's "Trust parent folder" once for that root, and later worktrees under it will not prompt.

## What it does not do

It does not manage worktrees, retry tasks, route work, or close terminals on its own. Checkout coordination covers children managed by this extension on this machine. It does not lock out the parent's own shell commands, other tools, or other machines, and the active ceiling is not a spending cap.

## Development

See [docs/development.md](docs/development.md) for the checks, the real Pi and Rex acceptance harness, and the testing hooks.

## License

MIT. See [LICENSE](LICENSE).
