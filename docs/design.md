# Design

`pi-rex-subagents` connects Pi's tool loop to Rex's native terminal multiplexer with minimal glue.

## Boundaries

- **Parent model:** chooses tasks, models, worktrees, and foreground vs. background execution. With the Rex skill (`rex __internal skill`), it can also inspect or rearrange panes on request using the returned `session` and `block` IDs.
- **User:** controls pane retention (`keepOpen` lives only in `config.json`, never in LLM tool arguments), drags/splits tabs natively in Rex, uses `/subagents` picker and `/subagents worktrees`, and claims ownership with `/subagent-takeover`.
- **Pi:** runs each subagent as a real interactive session, saves transcripts, handles `--fork`, and emits OSC 7501 status (`working`, `blocked`, `idle`, `done`, `error`).
- **Rex:** owns tabs, splits, floating layers, detached blocks, automatic pane close on exit (and retention on quick failures), waiting dots, Activity view, and desktop notifications.
- **Extension:** spawns Pi in Rex, isolates parallel writers with git worktrees, reports `agent_settled` results cleanly, delivers background completions in-loop (`turn_end` / `agent_before_settle`) or coalesced when idle with a quiet 1-line renderer, and bridges the one OSC 7501 gap (`project_trust`).

## Architecture

| File              | Responsibility                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`    | Entry point, double-load guard, quiet 1-line `subagent-results` renderer, `subagent` & `subagent_control` tools, event-driven widget, pre-settlement & coalesced background delivery, reload recovery |
| `src/launch.ts`   | Model/thinking resolution, concurrency gate, same-repo writer guard, launch/watch/cancel lifecycle, result formatting                                                                                 |
| `src/reporter.ts` | Child process hook: `agent_settled` → atomic `result.json` + shutdown, `/subagent-takeover`, OSC 7501 `project_trust` status                                                                          |
| `src/rex.ts`      | Thin typed CLI/API wrapper for Rex (`tab`, `split`, `float`, `detached`) and lazy `rex events --all --json` push stream                                                                               |
| `src/worktree.ts` | Git worktree creation (`<repo>.worktrees/<label>-<id>`), `git diff --stat` summary, safe cleanup                                                                                                      |
| `src/store.ts`    | Per-run directory (`run.json`, `task.md`, `result.json`, `taken_over`, `session/`), `config.json`, retention cleanup                                                                                  |
| `src/commands.ts` | `/subagents` slash command                                                                                                                                                                            |

## Key choices

1. **Flat delegation (depth 1):** Subagents do not load `subagent` or `subagent_control`. Eliminates reservation graphs, wait-cycle detection, slot parking, and tree cancellation cascades.
2. **Worktrees over file locks:** Parallel writers on one repo pass `worktree: true`. A lightweight in-memory check refuses accidental duplicate non-worktree writers from the same parent and points them to `worktree: true`.
3. **Read-only without breaking custom providers:** `readOnly: true` passes `--tools read,grep,find,ls --no-mcp` while keeping extensions loaded so extension-registered model providers (such as `claude-bridge`) continue working.
4. **Native Rex tab lifecycle, user-owned layout:** Panes open as unfocused tabs and close automatically on clean exit unless the user opts into `keepOpen` / another `placement` in `config.json` or runs `/subagent-takeover`. No background polling loop when idle.
5. **Seamless background delivery:** Finished background subagents are injected at `turn_end` / `agent_before_settle` while the parent is working (so the model sees them before wrapping up) and coalesced when idle. A custom message renderer replaces Pi's full-width purple custom-message box with a quiet 1-line summary (`Ctrl+O` to expand).
6. **Pure-Rex waiting navigation:** Because `src/reporter.ts` emits OSC 7501 `blocked` for `project_trust`, `rex/next_waiting.lua` queries Rex's native `com.superlogical.terminal.program_status` directly across all sessions without touching extension state files.
