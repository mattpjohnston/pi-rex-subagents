"""Check that cycle refusal fires only where the tree would otherwise deadlock.

Takeover and cancellation are switched off, because a human taking over a run can break a
wait cycle by hand, which hides the deadlock the refusal prevents.
"""
import random, sys
from collections import deque
from admission import check, initial, successors
from run import random_spec


def cycle_refusal_reachable(spec):
    start = initial(spec)
    seen, q = {start}, deque([start])
    while q:
        st = q.popleft()
        for ns, _ in successors(spec, st, "current"):
            for i, x in enumerate(ns[0]):
                p = spec.runs[i]["parent"]
                if x[0] == "refused" and st[0][i][0] != "refused" and not (spec.runs[p]["access"] == "inspect" and spec.runs[i]["access"] == "write"):
                    return True
            if ns not in seen:
                seen.add(ns)
                q.append(ns)
    return False


n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
counts = {"refusal and deadlock": 0, "refusal without deadlock": 0, "deadlock without refusal": 0, "neither": 0}
for k in range(n):
    spec = random_spec(rng, max_depth=2 if k % 2 else 3)
    spec.takeover, spec.cancel = set(), False
    spec.cycle_check = False
    dead = check(spec, "current")[0] == "DEADLOCK"
    spec.cycle_check = True
    refused = cycle_refusal_reachable(spec)
    counts[("refusal and deadlock" if dead else "refusal without deadlock") if refused else ("deadlock without refusal" if dead else "neither")] += 1
print(counts)
sys.exit(1 if counts["refusal without deadlock"] or counts["deadlock without refusal"] else 0)
