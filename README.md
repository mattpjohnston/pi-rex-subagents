# pi-rex-subagents

A lightweight [Pi](https://pi.dev) extension that runs subagents as real, interactive Pi sessions inside [Rex](https://www.superlogical.com/rex).

Each subagent opens directly in Rex as a tab, split, floating pane, or detached block. You can watch it live, type to steer it, answer dialogs, or run `/subagent-takeover` to keep it as your own session. When it finishes, it writes its final answer to disk, Rex closes the pane cleanly, and the parent gets the structured result.

## Why this design

- **Let Pi be Pi:** Subagents are fresh Pi processes with full TUI, sessions, OSC 7501 status, and `--fork` continuation.
- **Let Rex be Rex:** Placement (`tab`, `split`, `float`, `detached`), automatic tab cleanup on exit, waiting indicators, desktop notifications, and pane capture/navigation all use Rex natively. Tool outputs include Rex `session` and `block` IDs so Pi can also use the native Rex skill (`rex __internal skill`) directly.
- **Worktrees for parallel writers:** Pass `worktree: true` to run multiple writers on the same git repository at once in isolated worktrees. Clean, empty worktrees are removed automatically; worktrees with changes or commits are kept with a `git diff --stat` summary.
- **Flat and event-driven:** Depth 1 (no nested subagent trees), zero background polling loops when idle, and ~1,000 lines of TypeScript total.

## Requirements

- Pi 1.5.0+ running inside a local Rex terminal (`REX_SESSION` set).
- `git` (optional, required for `worktree: true`).

## Tools

### `subagent`

| Input                           | Meaning                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `task`                          | Complete, standalone task prompt (required).                                                           |
| `label`                         | Display name for the Rex tab or pane.                                                                  |
| `cwd`                           | Working directory (defaults to parent's).                                                              |
| `worktree`                      | Create an isolated git worktree at `<repo>.worktrees/<label>-<id>` on branch `subagent/<label>-<id>`.  |
| `readOnly`                      | Restrict tools to `read,grep,find,ls` with `--no-mcp` (keeps extensions/custom providers loaded).      |
| `background`                    | Return immediately with run + Rex IDs; results coalesce into one parent turn when finished.            |
| `placement`                     | `"tab"` (default), `"split"` (right of parent), `"float"` (right half of parent tab), or `"detached"`. |
| `keepOpen`                      | Keep the Rex pane open after Pi exits (default `false`; Rex always keeps quick crashes open).          |
| `continueFrom`                  | Fork a previous finished run's saved session (`--fork`).                                               |
| `provider`, `model`, `thinking` | Optional overrides (defaults inherited from parent).                                                   |

### `subagent_control`

- `list`: Lists this session's subagents, status, waiting state, worktrees, and Rex IDs.
- `wait`: Blocks until the named `runIds` finish (or `timeoutSeconds` elapses) and returns their results without duplicate delivery later.
- `cancel`: Stops a running subagent (never kills a taken-over session).

## Commands

- `/subagents` — List this session's subagents.
- `/subagents go <label|id>` — Jump to a subagent's pane (or reattach a detached one as a split).
- `/subagents go next` — Jump to the oldest waiting terminal across all Rex sessions.
- `/subagents cancel <label|id>` — Cancel a running subagent.
- `/subagents clear` — Close any finished panes left open (`keepOpen: true` or failed runs).
- `/subagent-takeover` (inside a subagent pane) — Claim ownership so the session stays open and stops reporting back.

## Rex key binding

`rex/next_waiting.lua` uses Rex's native `program_status` (no filesystem scraping) to jump to the oldest blocked terminal in any session:

```lua
dofile("/path/to/pi-rex-subagents/rex/next_waiting.lua")
rex.bind("ctrl+shift+n", "subagents_next_waiting")
```

## Configuration

Optional `~/.pi/agent/subagents/config.json`:

```json
{
  "maxConcurrent": 4,
  "keepOpen": false,
  "keepRunsForDays": 30
}
```

Set `PI_SUBAGENTS_STATE_DIR`, `PI_SUBAGENTS_PI`, or `PI_SUBAGENTS_REX` to override paths.

## Development

```sh
pnpm install
scripts/check.sh
```
