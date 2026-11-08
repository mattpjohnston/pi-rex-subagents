import random, sys
from admission import Spec, check

def H(plan): return {"parent": None, "access": None, "checkout": None, "mode": None, "plan": plan, "provider": None}
def R(parent, access, checkout, mode, plan=(), provider="p"):
    return {"parent": parent, "access": access, "checkout": checkout, "mode": mode, "plan": [list(b) for b in plan], "provider": provider}

# name: (spec, expected result under e18, expected result under the current rules)
NAMED = {
    "fifo_behind_unrelated_writer": (Spec([
        H([[2]]), H([[3]]), R(0, "write", "A", "bg", [[4]]), R(1, "write", "A", "bg"), R(2, "inspect", "A", "fg"),
    ], ceiling=4), "DEADLOCK", "OK"),
    "background_tree_at_ceiling": (Spec([
        H([[1, 2]]), R(0, "write", "A", "bg", [[3]]), R(0, "write", "B", "bg", [[4]]), R(1, "read", "A", "bg"), R(2, "read", "B", "bg"),
    ], ceiling=2), "DEADLOCK", "OK"),
    "nested_writer_same_checkout": (Spec([
        H([[1]]), R(0, "write", "A", "bg", [[2]]), R(1, "write", "A", "fg"),
    ], ceiling=4), "UNSAFE", "OK"),
    "inspectors_nest_writers": (Spec([
        H([[1, 2]]), R(0, "inspect", "A", "bg", [[3]]), R(0, "inspect", "A", "bg", [[4]]), R(1, "write", "A", "fg"), R(2, "write", "A", "fg"),
    ], ceiling=4), "DEADLOCK", "OK"),
    "resume_overshoot": (Spec([
        H([[2]]), H([[3]]), R(0, "write", "A", "bg", [[4]]), R(1, "write", "B", "bg"), R(2, "read", "C", "fg"),
    ], ceiling=1), "UNSAFE", "OK"),
    "takeover_descendant": (Spec([
        H([[1]]), R(0, "write", "A", "bg", [[2]]), R(1, "inspect", "A", "bg"),
    ], ceiling=4, takeover=[2]), "UNSAFE", "OK"),
    "middle_member_exits": (Spec([
        H([[1, 4]]), R(0, "write", "B", "bg", [[2]]), R(1, "write", "B", "fg", [[3]]), R(2, "inspect", "B", "bg"), R(0, "read", "B", "bg"),
    ], ceiling=3, takeover=[3], cancel=True), "UNSAFE", "OK"),
    "cross_checkout_cycle": (Spec([
        H([[2]]), H([[4]]), R(0, "write", "A", "bg", [[3]]), R(2, "read", "B", "bg"), R(1, "write", "B", "bg", [[5]]), R(4, "inspect", "A", "fg"),
    ], ceiling=3), "DEADLOCK", "OK"),
    # Sol: a cycle inside one tree, closed by a reservation member (depth 3).
    "cycle_inside_one_tree": (Spec([
        H([[1]]), R(0, "write", "A", "bg", [[2], [3]]), R(1, "write", "B", "bg", [[5]]), R(1, "inspect", "A", "bg", [[4]]),
        R(3, "inspect", "B", "fg"), R(2, "write", "A", "fg"),
    ], ceiling=6), "UNSAFE", "OK"),
    # Kimi: a nested repository inside an outer checkout is the same conflict.
    "nested_repository": (Spec([
        H([[2]]), H([[3]]), R(0, "write", "repo", "bg"), R(1, "write", "repo/nested", "bg"),
    ], ceiling=4), "OK", "OK"),
    # Kimi: a per-provider ceiling under a looser global one.
    "provider_ceiling": (Spec([
        H([[1, 2, 3]]), R(0, "write", "A", "bg", provider="xai"), R(0, "write", "B", "bg", provider="xai"), R(0, "read", "C", "bg", provider="p"),
    ], ceiling=4, providers={"xai": 1}), "OK", "OK"),
    # Sol and Grok: takeover of a parked run at a full ceiling counts, but admits nothing more.
    "takeover_parked_at_ceiling": (Spec([
        H([[1], [3]]), R(0, "write", "A", "bg", [[2]]), R(1, "read", "B", "fg"), R(0, "read", "C", "bg"),
    ], ceiling=1, takeover=[1]), "UNSAFE", "OK"),
}


def random_spec(rng, max_depth=2, roots=("A", "B"), budget=(2, 5)):
    runs = [H([]) for _ in range(rng.choice([1, 2]))]
    humans, left = len(runs), rng.randint(*budget)
    def add(parent, depth):
        nonlocal left
        if left <= 0:
            return
        left -= 1
        acc, idx = rng.choice(["read", "inspect", "write"]), len(runs)
        co = rng.choice(roots)
        if rng.random() < 0.15:
            co += "/n"
        runs.append(R(parent, acc, co, rng.choice(["fg", "bg"]), provider=rng.choice(["p", "q"])))
        if rng.random() < 0.6 or not runs[parent]["plan"]:
            runs[parent]["plan"].append([idx])
        else:
            runs[parent]["plan"][-1].append(idx)
        if acc != "read" and depth < max_depth:
            for _ in range(rng.choice([0, 1, 2])):
                add(idx, depth + 1)
    for h in range(humans):
        add(h, 0)
    while left > 0:
        add(rng.randrange(humans), 0)
    providers = {"q": 1} if rng.random() < 0.3 else {}
    takeover = [i for i in range(humans, len(runs)) if rng.random() < 0.2]
    return Spec(runs, ceiling=rng.choice([1, 2, 3, 4]), providers=providers, takeover=takeover, cancel=rng.random() < 0.3)


if __name__ == "__main__":
    failed = 0
    for name, (spec, want_e18, want_now) in NAMED.items():
        for rules, want in (("e18", want_e18), ("current", want_now)):
            got = check(spec, rules)
            ok = got[0] == want
            failed += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {name:30} {rules:8} expected {want:8} got {got[0]:8} {got[1] if got[0] != 'OK' else ''}")
            if not ok:
                print("     trace:", " -> ".join(got[2]))
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    rng, tally = random.Random(19), {}
    for k in range(n):
        spec = random_spec(rng, max_depth=2 if k % 2 else 3, roots=("A", "B") if k % 3 else ("A", "B", "C"), budget=(2, 5) if k % 4 else (4, 7))
        got = check(spec, "current")
        tally[got[0]] = tally.get(got[0], 0) + 1
        if got[0] in ("UNSAFE", "DEADLOCK"):
            failed += 1
            if failed < 4:
                print("random tree", k, got[0], got[1], [(i, r["parent"], r["access"], r["checkout"], r["mode"], r["plan"], r["provider"]) for i, r in enumerate(spec.runs)], spec.ceiling, spec.providers, sorted(spec.takeover), spec.cancel)
                print("     trace:", " -> ".join(got[2]))
    print(f"random sweep under the current rules, {n} trees: {tally}")
    sys.exit(1 if failed else 0)
