# Progress

Newest entry last. Each entry says what was done, the evidence, what failed, and what's next. `docs/roadmap.json` holds the work and its status.

## 2026-11-15 Review finished, roadmap started

The end-to-end review is on main (5d42c2c..d7dfc10, 36 commits). The full harness suite passed on d7dfc10. Its unfixed list became the roadmap, with the features the spec had deferred, approved by the user today:

- The parent may type into a child's tab to answer a dialog. Messages still go through the inbox, because a typed message can answer a dialog by accident.
- No changes requested from Pi. Pi 1.5.2 gives an extension no way to answer another extension's dialog, so dialogs are answered with Rex keys.
- Worktrees: opt-in, under one root next to the repository, a branch per run, never removed with uncommitted or unmerged work.

Found while setting up: a research subagent started from the home directory (run f18a68b7c90c1c18799bebdc, a writer with cwd /Users/matt) reserved the whole home tree, so the parent guard refused every edit in this repository. That became the first roadmap item, home-checkout.

Next: home-checkout.
