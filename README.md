# pi-rex-subagents

A [Pi](https://pi.dev) extension that runs subagents as separate Pi sessions in [Rex](https://www.superlogical.com/rex) tabs. You can open a subagent's tab to watch it, type to steer it, or take it over and keep working in it yourself. When it finishes, it writes its final answer to a file and the parent reads that file.

## What it does

- Runs several subagents at once. A call can wait for its subagent to finish, or return straight away and deliver the result later.
- Stops two subagents from editing the same repository at once, across every Pi on your machine. Read-only subagents can share a repository.
- Caps how many subagents run at once, machine-wide, with an optional cap per provider.
- Offers a read-only mode with file tools and a locked-down `git` tool, and an "inspect" mode that keeps the shell but reports any files that changed.
- Lets subagents start their own subagents, two levels deep by default.
- Gives the parent a `subagent_control` tool to list, cancel, and message its subagents.
- Closes a finished subagent's tab a minute after it exits, unless you're looking at it or have pinned it.
- Includes a Rex key binding that jumps to the oldest subagent waiting for you.

[docs/design.md](docs/design.md) explains how it works.

## Requirements

- Pi 1.5.0 or later, logged in to the providers your subagents will use.
- Rex running on the same machine. Start the parent Pi inside a Rex tab, because subagents open as tabs in the same Rex session.
- Git, for the repository checks and the read-only `git` tool.

## Install

```sh
pi install npm:pi-rex-subagents
```

Or from GitHub:

```sh
pi install git:github.com/mattpjohnston/pi-rex-subagents
```

To try it for one session, run `pi -e npm:pi-rex-subagents`.

This extension adds a tool called `subagent`. If another extension you use also adds one, remove that extension first.

## Usage

Ask Pi to hand work to a subagent. It calls the `subagent` tool with these inputs:

| Input                           | Meaning                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `task`                          | The full task. The subagent can't see the parent's conversation, so the task must stand alone. |
| `label`                         | Name for the tab.                                                                              |
| `cwd`                           | Working directory. Defaults to the parent's.                                                   |
| `access`                        | `write` (default), `read`, or `inspect`. See below.                                            |
| `background`                    | If `true`, the call returns at once and the result arrives later as a message.                 |
| `continueFrom`                  | ID of an earlier, finished run. The new subagent starts with a copy of that conversation.      |
| `provider`, `model`, `thinking` | Model settings. Anything you leave out is copied from the parent.                              |

Each subagent opens in a new tab in your Rex session, without switching to it. Open the tab to watch. Press Enter to send it a message and Escape to interrupt it, as in any Pi session.

A call that isn't `background` waits for the subagent to finish, and you can't steer the parent until it does. Several calls in one message run at the same time. Use `background` for long tasks, or when you want to keep talking to the parent.

Ask subagents for a short final report, and to put anything long in a file. The parent sees at most 50 KB or 2,000 lines of each result, plus the path to the full conversation.

### Access modes

- `write` gets your normal Pi setup. Only one `write` subagent works in a repository at a time.
- `read` gets `read`, `grep`, `find`, `ls`, and `git_read`, which runs read-only Git commands like `log`, `show`, and `diff`. It has no shell, extensions, or MCP servers. The extension checks the tool list before the task starts, and stops the subagent if anything else is available. This limits Pi's tools. It isn't an operating-system sandbox.
- `inspect` gets your normal Pi setup minus the `edit` and `write` tools, so it still has a shell and MCP servers. It can share a repository with `read` subagents. The extension records every file before and after the run, and the result lists any that changed. Nothing stops an `inspect` subagent from writing files with the shell. You just find out afterwards.

### Commands

- `/subagents` lists this session's subagents, with any waiting for you at the top.
- `/subagents all` lists running subagents from every Pi session.
- `/subagents go <label>` switches Rex to that subagent's tab.
- `/subagents go next` switches to the subagent that has waited longest for you.
- `/subagents cancel <label>` cancels a background subagent.
- `/subagents keep <label>` stops a tab from closing automatically.
- `/subagents clear` closes the tabs of finished subagents.
- `/subagents dismiss <label>` closes one finished subagent's tab.
- `/subagent-takeover`, typed in a subagent's own tab, makes the session yours. It stops reporting to the parent and won't exit when it's done.

Closing a tab doesn't delete anything. The conversation, result, and records stay on disk until an old run is deleted after `keepRunsFor` days.

When a subagent needs you, for example to answer a dialog or Pi's trust prompt, the parent shows a notice with the `/subagents go` command for it. The subagent's tab shows as waiting in Rex, and Rex sends a desktop notification if you've turned on notifications for programs waiting for you in its settings.

### Rex key bindings

Add these to Rex's `init.lua`, then run `rex config reload`:

```lua
dofile("/path/to/pi-rex-subagents/rex/next_waiting.lua")
rex.bind("ctrl+shift+n", "subagents_next_waiting")
dofile("/path/to/pi-rex-subagents/rex/keep.lua")
rex.bind("ctrl+shift+k", "subagents_keep")
```

`subagents_next_waiting` jumps to the subagent that has waited longest for you, in any session. `subagents_keep` pins or unpins the tab you're in.

### Finished tabs

When a subagent completes, its tab closes 60 seconds after the process exits. It stays open while it's the selected tab in its session, and closes about 5 seconds after you switch away.

To keep a tab, pin it. Press the `subagents_keep` key in the tab, which adds `📌` to its name, or run `/subagents keep <label>` in the parent. Renaming the tab also keeps it. `/subagents clear` skips pinned tabs, and `/subagents dismiss` closes them.

Tabs of subagents that failed, were cancelled, or that you took over don't close automatically.

### Parent controls

The parent model can call `subagent_control`:

- `list` shows its subagents and what each is doing.
- `cancel` stops one. It won't cancel a subagent you've taken over.
- `message` sends one a short instruction, such as "stop" or "wait before committing". The tool reports `accepted`, `refused`, or `unacknowledged` after 10 seconds. A subagent never finishes with an accepted message it hasn't read yet.

### Settings

Settings live in `~/.pi/agent/subagents/limits.json`. The extension reads it before each launch, so changes apply straight away.

```json
{
  "active": 4,
  "depth": 2,
  "providers": { "openrouter": 2 },
  "closeCompletedAfter": 60,
  "keepRunsFor": 30
}
```

- `active` is how many subagents can run at once across your machine. The default is 4.
- `providers` caps subagents per provider.
- `depth` is how many levels of subagents can exist below a session you started. The default is 2. Set it to 1 to stop subagents starting their own.
- `closeCompletedAfter` is how many seconds a finished tab stays open. Set it to `false` to keep tabs.
- `keepRunsFor` is how many days to keep a finished run's conversation, result, and records. The default is 30. Set it to `false` to keep everything. Each time Pi starts, older runs are deleted, but never one that is running, queued, taken over, or whose result hasn't reached its parent yet.

If the file is missing, the defaults apply. If it's invalid, launches stop with an error that names the file.

To keep state somewhere else, set `PI_SUBAGENTS_STATE_DIR`. If `pi` or `rex` isn't on your `PATH`, set `PI_SUBAGENTS_PI` or `PI_SUBAGENTS_REX`.

### Project trust

Subagents follow Pi's usual trust prompts for their working directory, and the extension never answers one for you. If you keep worktrees in one folder, choose Pi's "Trust parent folder" once for that folder, and new worktrees inside it won't prompt.

## Limitations

- It doesn't create worktrees, retry failed tasks, or choose models. The parent decides those.
- The repository rules apply only to subagents started by this extension on this machine. They don't stop the parent's own shell commands or anything else editing the files.
- The cap on running subagents isn't a spending limit.

## Development

[docs/development.md](docs/development.md) covers the checks, the end-to-end tests against real Pi and Rex, and the test-only settings.

## License

MIT. See [LICENSE](LICENSE).
