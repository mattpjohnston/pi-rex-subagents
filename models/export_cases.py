"""Export reachable admission verdicts; generated cases stay outside the repository."""
import json
import random
import sys
from collections import deque

from admission import (
    blockers, has_slot, initial, on_cycle, reservation_for, successors,
    waits_for, wakeable,
)
from run import random_spec


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


def main():
    rng, count, trees = random.Random(42), 0, 2200
    with open(sys.argv[1], "w", encoding="utf-8") as output:
        for k in range(trees):
            spec = random_spec(rng, max_depth=1 + k % 3, roots=("A", "B", "C"), budget=(3, 7))
            start = initial(spec)
            seen, queue = {start}, deque([start])
            sampled = 0
            while queue and sampled < 20:
                state = queue.popleft()
                output.write(json.dumps(case(spec, state), separators=(",", ":")) + "\n")
                count += 1
                sampled += 1
                next_states = successors(spec, state, "current")
                rng.shuffle(next_states)
                for ns, _ in next_states:
                    if ns not in seen:
                        seen.add(ns)
                        queue.append(ns)
    print(json.dumps({"states": count, "trees": trees, "seed": 42, "depths": [1, 2, 3]}))
    if count < 20000:
        raise RuntimeError("Insufficient reachable states")


if __name__ == "__main__":
    main()
