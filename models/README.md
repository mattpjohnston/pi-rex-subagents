# Models of the subagent rules

Two exhaustive models of rules in `../docs/design.md`. Each explores every interleaving of its steps and runs the earlier rules beside the current ones. A script exits nonzero unless the earlier rules fail where expected and the current rules pass.

```sh
python3 -B run.py 20000     # admission: named schedules under the E18 and current rules, then 20,000 random trees
python3 -B vacuity.py 5000  # cycle refusal fires exactly where a tree would deadlock without it
python3 -B protocol.py      # one run's lock, claim, inbox, settlement, takeover, and cancellation
```

`admission.py` covers reservations per tree and checkout, overlapping checkout roots, parked runs and slot reacquisition, the active and per-provider ceilings, refusal of launches that would close a wait cycle, settlement and delivery of descendant outcomes, takeover, and cancellation. It fails on a deadlock, on an active writer beside another active holder of an overlapping checkout, or on more model-driven runs than a ceiling allows. A human takeover may exceed a ceiling, as the spec permits.

`protocol.py` covers one run with two messages, settlement, Pi's deferred turn, takeover, cancellation, and a parent crash. It fails when a run claims `result` with an accepted message unconsumed, or when the run can get stuck.

Both models make each step atomic under its lock. They do not cover races inside a step, Rex or Pi failures, a child process crash, the parent's own tool calls racing a join, or branch navigation. Those are acceptance-harness items. Change the models with every rule they cover, and rerun them.
