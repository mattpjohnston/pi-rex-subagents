# Progress

Newest entry last. Each entry says what was done, the evidence, what failed, and what's next. `docs/roadmap.json` holds the work and its status.

## 2026-11-15 Review finished, roadmap started

The end-to-end review is on main (5d42c2c..d7dfc10, 36 commits). The full harness suite passed on d7dfc10. Its unfixed list became the roadmap, with the features the spec had deferred, approved by the user today:

- The parent may type into a child's tab to answer a dialog. Messages still go through the inbox, because a typed message can answer a dialog by accident.
- No changes requested from Pi. Pi 1.5.2 gives an extension no way to answer another extension's dialog, so dialogs are answered with Rex keys.
- Worktrees: opt-in, under one root next to the repository, a branch per run, never removed with uncommitted or unmerged work.

Found while setting up: a research subagent started from the home directory (run f18a68b7c90c1c18799bebdc, a writer with cwd /Users/matt) reserved the whole home tree, so the parent guard refused every edit in this repository. That became the first roadmap item, home-checkout.

Next: home-checkout.

## 2026-11-15 home-checkout

A plain directory (not inside any git repository) no longer conflicts with repositories inside it, in admission and in the parent's edit guard. Plain directories still conflict with each other and with plain directories inside them. The admission model changed first: its new check shows the home and repository writers never hold at once under the old rule and do under the new one, and the random sweep now includes plain-directory roots. Admission uses `conflicts()` in admission-core.ts; the guard uses `checkoutHolds()` in checkout.ts, which looks for a `.git` between the plain directory and the target.

Next: release.

## 2026-11-15 release

`/subagents release <label|run-id>` frees an uncertain launch: no Rex tab recorded and the process unresolved or unknown. It asks the person to confirm nothing is running, rechecks under the admission lock, drops the reservation and ticket, and records `releasedAt` with the process exited. It refuses a known tab, a live process, a takeover, or an already-exited process. `releaseRefusal()` and `releaseRun()` are in admission.ts.

Next: lost-message.

## 2026-11-15 lost-message

Pi settles only after running what it queued, so a message marked sent before the latest settlement and still unconsumed was dropped. The reporter now marks such messages `lost` and settlement sends them again; it used to wait for them forever. The protocol model gained a "Pi drops a queued message" step and a check that every state can finish without someone stepping in; the old rule (`nov14`) fails it and the current rule passes. The roadmap's "after a reporter reload" case is covered by the same rule rather than a separate reload hook. Duplicates are possible in a same-millisecond race and accepted.

Next: nested-git.
