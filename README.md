# pi-rex-subagents

A lightweight [Pi](https://pi.dev) extension that runs subagents as real, interactive Pi sessions inside [Rex](https://www.superlogical.com/rex).

Each subagent opens quietly as an unfocused Rex tab in your current session. You can watch it live in Rex's sidebar, type mid-turn to steer, answer dialogs, or run `/subagent-takeover` before interrupting with Escape to keep it as your own session. When it finishes, it writes its final answer to disk, Rex closes the tab cleanly, and the parent gets the structured result.

## Why this design

- **Quiet by default:** Subagents open as unfocused background tabs and close automatically on completion. The model never splits your active pane, pops floating overlays, or leaves dead terminals behind.
- **Let Pi be Pi:** Subagents are fresh Pi processes with full TUI, saved sessions, OSC 7501 status, and `--fork` continuation. Multiple foreground calls in one turn run in parallel automatically and return one cohesive parent answer.
- **Let Rex be Rex:** Waiting dots, Activity view, desktop notifications, automatic tab cleanup on exit (and retention on quick startup crashes), and pane capture/navigation all use Rex natively. Tool outputs include Rex `session` and `block` IDs so Pi can also use the native Rex skill (`rex __internal skill`) when you ask for layout changes.
- **Worktrees for parallel writers:** Pass `worktree: true` to run multiple writers on the same git repository at once in isolated worktrees. Clean, empty worktrees are removed automatically; worktrees with changes or commits are kept with a `git diff --stat` summary.
- **Flat and event-driven:** Depth 1 (no nested subagent trees), zero background polling loops when idle, and a quiet 1-line renderer for background deliveries (`Ctrl+O` to expand raw output).

## Requirements

- Pi 1.5.0+ running inside a local Rex terminal (`REX_SESSION` set).
- `git` (optional, required for `worktree: true`).

## Tools

### `subagent`

| Input                           | Meaning                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`                          | Complete, standalone task prompt (required).                                                                                                                                                                               |
| `label`                         | Display name for the Rex tab.                                                                                                                                                                                              |
| `cwd`                           | Working directory (defaults to parent's).                                                                                                                                                                                  |
| `worktree`                      | Create an isolated git worktree at `<repo>.worktrees/<label>-<id>` on branch `subagent/<label>-<id>`.                                                                                                                      |
| `access`                        | `"write"` (default, full tools), `"inspect"` (full tools including bash/MCP except `edit`/`write`; runs in parallel freely), or `"read"` (`read,grep,find,ls` only, `--no-mcp`; keeps extensions/custom providers loaded). |
| `background`                    | Return immediately so you can keep chatting while a long task runs; finished results arrive cleanly in-loop or coalesced when idle.                                                                                        |
| `placement`                     | Optional `"tab"` (default), `"split"`, `"float"`, or `"detached"` — only set when you explicitly ask for that layout (always closes on exit).                                                                              |
| `continueFrom`                  | Fork a previous finished run's saved session (`--fork`).                                                                                                                                                                   |
| `provider`, `model`, `thinking` | Optional overrides (defaults inherited from parent).                                                                                                                                                                       |

### `subagent_control`

- `list`: Lists this session's subagents, status, waiting state, worktrees, and Rex IDs.
- `wait`: Blocks until the named `runIds` finish (or `timeoutSeconds` elapses) and returns their results without duplicate delivery later.
- `cancel`: Stops a running subagent (never kills a taken-over session).

## Commands

- `/subagents` — Open an interactive picker for this session's subagents (jump to Rex pane, cancel, or inspect details).
- `/subagents go <label|id>` — Jump to a subagent's pane (or reattach a detached one as a split).
- `/subagents go next` — Jump to the oldest waiting terminal across all Rex sessions.
- `/subagents cancel <label|id>` — Cancel a running subagent.
- `/subagents worktrees` — List and remove leftover `subagent/*` worktrees for this repository.
- `/subagents clear` — Close any finished panes left open (`keepOpen: true` in config or failed runs).
- `/subagent-takeover` (inside a subagent pane) — Claim ownership so the session stays open and stops reporting back.

## Rex key binding

`rex/next_waiting.lua` uses Rex's native `program_status` (no filesystem scraping) to jump to the oldest blocked terminal in any session:

```lua
dofile("/path/to/pi-rex-subagents/rex/next_waiting.lua")
rex.bind("ctrl+shift+n", "subagents_next_waiting")
```

## Configuration

Optional `~/.pi/agent/subagents/config.json` (user preferences only — not controllable by the LLM):

```json
{
  "maxConcurrent": 4,
  "placement": "tab",
  "keepOpen": false,
  "keepRunsForDays": 30
}
```

`placement` may be `"tab"` (default), `"split"`, `"float"`, or `"detached"`.

Set `PI_SUBAGENTS_STATE_DIR`, `PI_SUBAGENTS_PI`, or `PI_SUBAGENTS_REX` to override paths.

## Development

```sh
pnpm install
scripts/check.sh
```
