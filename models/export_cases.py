"""Export reachable admission verdicts; generated cases stay outside the repository."""
import json
import random
import sys
from collections import deque

from admission import (
    blockers, has_slot, initial, on_cycle, reservation_for, successors,
    waits_for, wakeable,
)
from run import NAMED, random_spec


def snapshot(spec, s):
    return {
        "limits": {"active": spec.ceiling, "depth": 3, "providers": spec.providers},
        "runs": [
            {
                "id": str(i),
                "parent": str(r["parent"]) if spec.managed(r["parent"]) else None,
                "access": r["access"], "checkout": r["checkout"], "provider": r["provider"],
                "state": {"parked_fg": "parked", "parked_settle": "parked", "pending": "exited", "refused": "exited"}.get(s[i][0], s[i][0]),
                "reservation": str(s[i][3]) if s[i][3] is not None else None,
                "ticket": s[i][4], "detached": s[i][5],
                "readyToWake": wakeable(spec, s, i),
            }
            for i, r in enumerate(spec.runs) if spec.managed(i)
        ],
    }


def case(spec, state):
    s, seq = state
    older, verdicts, launches = [], [], []
    for _, i in sorted((s[i][4], i) for i in range(spec.n) if s[i][0] == "queued"):
        verdicts.append({"id": str(i), "blockers": sorted(map(str, blockers(spec, s, i, "current", older)))})
        older.append(i)
    admitted = next((label.split()[1] for _, label in successors(spec, state, "current") if label.startswith("admit ")), None)
    # Reproduce the model's incremental launch boundary, not a reconstructed final batch.
    for i, r in enumerate(spec.runs):
        if s[i][0] != "running" or s[i][1] >= len(r["plan"]):
            continue
        ns, nseq = list(s), seq
        for c in r["plan"][s[i][1]]:
            if r["access"] == "inspect" and spec.runs[c]["access"] == "write":
                ns[c] = ("refused",) + ns[c][1:]
                continue
            ns[c] = ("queued", 0, frozenset(), None, nseq, False)
            nseq += 1
            refused = on_cycle(waits_for(spec, ns, "current"), c)
            launches.append({"snapshot": snapshot(spec, ns), "id": str(c), "refused": refused})
            if refused:
                ns[c] = ("refused",) + ns[c][1:]
    return {
        "snapshot": snapshot(spec, s), "blockers": verdicts,
        "admit": None if admitted is None else {"id": admitted, "reservation": str(reservation_for(spec, s, int(admitted), "current") if reservation_for(spec, s, int(admitted), "current") is not None else admitted)},
        "wakes": [{"id": str(i), "hasSlot": has_slot(spec, s, i, "current")} for i in range(spec.n) if wakeable(spec, s, i)],
        "launches": launches,
    }


def flags(exported):
    runs = exported["snapshot"]["runs"]
    queued = {r["id"] for r in runs if r["state"] == "queued"}
    reservations = {}
    for run in runs:
        if run["reservation"] and run["state"] not in ("queued", "exited"):
            reservations[run["reservation"]] = reservations.get(run["reservation"], 0) + 1
    return {
        "parked": any(r["state"] == "parked" for r in runs),
        "taken": any(r["state"] == "taken" for r in runs),
        "joined": any(n >= 2 for n in reservations.values()),
        "olderTicket": any(queued.intersection(v["blockers"]) for v in exported["blockers"]),
        "cycle": any(launch["refused"] for launch in exported["launches"]),
        "wakeWithoutSlot": any(not wake["hasSlot"] for wake in exported["wakes"]),
    }


def sample_tree(spec, rng, cap):
    """Full exploration when it fits; otherwise walks to terminal states plus a depth spread."""
    start = initial(spec)
    seen, queue, bfs = {start}, deque([start]), []
    while queue and len(bfs) < cap:
        state = queue.popleft()
        bfs.append(state)
        nxt = list(successors(spec, state, "current"))
        rng.shuffle(nxt)
        for ns, _ in nxt:
            if ns not in seen:
                seen.add(ns)
                queue.append(ns)
    if not queue:
        return bfs
    chosen, have = [], set()

    def add(state):
        if state not in have:
            have.add(state)
            chosen.append(state)

    for state in bfs[:: max(1, len(bfs) // 8)]:
        add(state)
    for _ in range(8):
        state = start
        add(state)
        for _step in range(80):
            nxt = successors(spec, state, "current")
            if not nxt:
                break
            state = rng.choice(nxt)[0]
            add(state)
    return chosen


def main():
    rng, count, trees = random.Random(42), 0, 0
    coverage = {key: 0 for key in ("parked", "taken", "joined", "olderTicket", "cycle", "wakeWithoutSlot")}
    with open(sys.argv[1], "w", encoding="utf-8") as output:
        def emit(spec):
            nonlocal count, trees
            trees += 1
            for state in sample_tree(spec, rng, 400 if trees <= len(NAMED) else 120):
                exported = case(spec, state)
                output.write(json.dumps(exported, separators=(",", ":")) + "\n")
                count += 1
                for key, hit in flags(exported).items():
                    coverage[key] += int(hit)

        for _name, (spec, _old, _now) in NAMED.items():
            emit(spec)
        while count < 20000 or trees < 2000:
            emit(random_spec(rng, max_depth=1 + trees % 3, roots=("A", "B", "C"), budget=(3, 7)))
    summary = {"states": count, "trees": trees, "seed": 42, "depths": [1, 2, 3], "coverage": coverage}
    print(json.dumps(summary))
    missing = [key for key, n in coverage.items() if n == 0]
    if count < 20000 or trees < 2000 or missing:
        raise RuntimeError(f"Insufficient coverage: {summary} missing={missing}")


if __name__ == "__main__":
    main()
