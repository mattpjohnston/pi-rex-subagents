# Changelog

## [0.1.0] - 2026-11-09

First release.

- `subagent` runs a task in a fresh Pi session in a Rex tab, foreground or background, with `read`, `inspect`, and `write` access.
- Machine-wide admission: readers share a checkout, writers get it alone, and active and per-provider ceilings apply across every parent.
- Background results are coalesced into one parent turn and reconciled after reloads and crashes.
- `subagent_control` lists, cancels, and messages running children, with acknowledged delivery.
- Nested children, two levels deep by default.
- A Rex action that jumps to the oldest waiting child, and a desktop notice when a child waits.
- Completed children close their tabs after a grace period, never while you are viewing them. Pin a tab (the `subagents_keep` Rex action, `/subagents keep`, or renaming it) to keep it.
