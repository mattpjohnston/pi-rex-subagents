"""Exhaustive model of subagent admission: reservations, parking, cycle refusal, ceilings.

RULES="current" follows ../docs/design.md. RULES="e18" follows the 3 November amendment
before the E19 correction, so the named schedules can show the checker catches its failures.
Each transition is atomic under the admission lock. Messages, settlement races, and Rex or Pi
failures are outside this model; see protocol.py and the acceptance harness.
"""
from collections import deque

COMPAT = {("read", "read"), ("read", "inspect"), ("inspect", "read"), ("inspect", "inspect")}
LIVE = {"running", "parked_fg", "parked_settle", "taken"}
HOLDING = LIVE  # a run holds its reservation membership while its process lives


def overlaps(x, y):
    """Checkouts conflict when their roots are equal or one contains the other."""
    return x == y or x.startswith(y + "/") or y.startswith(x + "/")


class Spec:
    def __init__(self, runs, ceiling, providers=None, takeover=(), cancel=False):
        # runs: dicts {parent, access, checkout, mode, plan:[[child ids]], provider}; parent None = human session
        self.runs, self.ceiling = runs, ceiling
        self.providers = providers or {}
        self.takeover, self.cancel = set(takeover), cancel
        self.cycle_check = True
        self.n = len(runs)
        for i, r in enumerate(runs):
            for batch in r["plan"]:
                for c in batch:
                    assert runs[c]["parent"] == i, f"run {c} is launched by {i} but its parent is {runs[c]['parent']}"

    def managed(self, i):
        return self.runs[i]["parent"] is not None

    def ancestors(self, i):
        out, p = [], self.runs[i]["parent"]
        while p is not None:
            out.append(p)
            p = self.runs[p]["parent"]
        return out

    def children(self, i):
        return [c for c in range(self.n) if self.runs[c]["parent"] == i]

    def descendants(self, i):
        out = []
        for c in self.children(i):
            out.append(c)
            out.extend(self.descendants(c))
        return out


# Dynamic run state: (status, step, pending, reservation, ticket, detached)
# reservation: None, or the id of the run that opened the reservation this run is a member of.

def initial(spec):
    return (tuple(("running" if r["parent"] is None else "pending", 0, frozenset(), None, None, False) for r in spec.runs), 0)


def holds(spec, s, i):
    return s[i][3] is not None and s[i][0] in HOLDING


def reservation_for(spec, s, t, rules):
    """The reservation a launch joins: one held by an ancestor on an overlapping checkout."""
    if rules != "current":
        return None
    X = spec.runs[t]["checkout"]
    for a in spec.ancestors(t):
        if holds(spec, s, a) and overlaps(spec.runs[a]["checkout"], X):
            return s[a][3]
    return None


def suspended(spec, s):
    """Members with a live descendant member of the same reservation may not edit or write."""
    out = set()
    for i in range(spec.n):
        if holds(spec, s, i):
            for a in spec.ancestors(i):
                if holds(spec, s, a) and s[a][3] == s[i][3]:
                    out.add(a)
    return out


def counted(spec, s, rules, provider=None):
    n = 0
    for i in range(spec.n):
        if not spec.managed(i) or (provider and spec.runs[i]["provider"] != provider):
            continue
        st = s[i][0]
        if st in ("running", "taken") or (st == "parked_settle" and rules == "e18"):
            n += 1
    return n


def has_slot(spec, s, i, rules):
    p = spec.runs[i]["provider"]
    if counted(spec, s, rules) >= spec.ceiling:
        return False
    return p not in spec.providers or counted(spec, s, rules, p) < spec.providers[p]


def wakeable(spec, s, i):
    st, step, pending = s[i][:3]
    if st == "parked_fg":
        batch = spec.runs[i]["plan"][step - 1]
        return all(s[c][0] in ("exited", "refused", "pending") or s[c][5] for c in batch if spec.runs[c]["mode"] == "fg")
    return st == "parked_settle" and bool(pending)


def blockers(spec, s, t, rules, older):
    """Runs and older tickets that block ticket t on its checkout."""
    X, acc, anc = spec.runs[t]["checkout"], spec.runs[t]["access"], set(spec.ancestors(t))
    res = reservation_for(spec, s, t, rules)
    out = set()
    for j in range(spec.n):
        if j == t or not holds(spec, s, j) or not overlaps(spec.runs[j]["checkout"], X):
            continue
        if j in anc and (rules == "e18" or s[j][3] == res):
            continue  # an ancestor's own lease, or a member of the reservation t joins
        if (acc, spec.runs[j]["access"]) not in COMPAT:
            out.add(j)
    for j in older:
        if not overlaps(spec.runs[j]["checkout"], X) or (acc, spec.runs[j]["access"]) in COMPAT:
            continue
        if rules == "e18" and j in anc:
            continue
        if res is not None and reservation_for(spec, s, j, rules) != res:
            continue  # tickets outside the reservation wait behind it, not the reverse
        out.add(j)
    return out


def waits_for(spec, s, rules):
    edges = {i: set() for i in range(spec.n)}
    for i in range(spec.n):
        if spec.managed(i) and s[i][0] in LIVE | {"queued"} and s[i][0] != "taken":
            edges[i] |= {c for c in spec.children(i) if s[c][0] in LIVE | {"queued"} and not s[c][5]}
    older = []
    for _, t in sorted((s[i][4], i) for i in range(spec.n) if s[i][0] == "queued"):
        edges[t] |= blockers(spec, s, t, rules, older)
        older.append(t)
    return edges


def on_cycle(edges, start):
    seen, stack = set(), [start]
    while stack:
        for m in edges[stack.pop()]:
            if m == start:
                return True
            if m not in seen:
                seen.add(m)
                stack.append(m)
    return False


def successors(spec, state, rules):
    s, seq = list(state[0]), state[1]
    out = []

    def emit(ns, nseq, label):
        out.append(((tuple(ns), nseq), label))

    def deliver(ns, i):
        p = spec.runs[i]["parent"]
        if p is not None and spec.managed(p) and ns[p][0] != "exited" and not ns[i][5]:
            ps = ns[p]
            ns[p] = (ps[0], ps[1], ps[2] | {i}, ps[3], ps[4], ps[5])

    def finish(ns, i, notify=True):
        st, step, _, _, _, det = ns[i]
        ns[i] = ("exited", step, frozenset(), None, None, det)
        if notify:
            deliver(ns, i)

    def cancel_tree(ns, i):
        # Cancellation never ends a human-owned run, or anything under it.
        if ns[i][0] == "taken":
            return
        for c in spec.children(i):
            cancel_tree(ns, c)
        if ns[i][0] == "pending":
            return
        if ns[i][0] not in ("exited", "refused"):
            finish(ns, i, notify=False)

    for i in range(spec.n):
        st, step, pending, res, ticket, det = s[i]
        r = spec.runs[i]
        if st == "running" and step < len(r["plan"]):
            ns, nseq, any_fg = s[:], seq, False
            for c in r["plan"][step]:
                if rules == "current" and r["access"] == "inspect" and spec.runs[c]["access"] == "write":
                    ns[c] = ("refused",) + ns[c][1:]
                    continue
                ns[c] = ("queued", 0, frozenset(), None, nseq, False)
                nseq += 1
                if rules == "current" and spec.cycle_check and on_cycle(waits_for(spec, ns, rules), c):
                    ns[c] = ("refused",) + ns[c][1:]
                    continue
                any_fg |= spec.runs[c]["mode"] == "fg"
            ns[i] = (("parked_fg" if spec.managed(i) else "human_wait") if any_fg else st, step + 1, pending, res, ticket, det)
            emit(ns, nseq, f"launch {i} batch {step}")
        if st == "human_wait":
            batch = r["plan"][step - 1]
            if all(s[c][0] in ("exited", "refused", "pending") or s[c][5] for c in batch if spec.runs[c]["mode"] == "fg"):
                ns = s[:]
                ns[i] = ("running",) + s[i][1:]
                emit(ns, seq, f"human {i} resumes")
        if st == "running" and step >= len(r["plan"]) and spec.managed(i):
            ns = s[:]
            if pending:
                ns[i] = ("running", step, frozenset(), res, ticket, det)
                emit(ns, seq, f"{i} consumes outcomes")
            elif any(s[c][0] in LIVE | {"queued"} and not s[c][5] for c in spec.children(i)):
                ns[i] = ("parked_settle", step, pending, res, ticket, det)
                emit(ns, seq, f"{i} parks after settling")
            else:
                finish(ns, i)
                emit(ns, seq, f"{i} publishes and exits")
        if wakeable(spec, s, i):
            # E18 resumed a foreground waiter without taking a slot back.
            if (rules == "e18" and st == "parked_fg") or (rules == "e18" and st == "parked_settle") or has_slot(spec, s, i, rules):
                ns = s[:]
                ns[i] = ("running", step, pending, res, ticket, det)
                emit(ns, seq, f"wake {i}")
        if i in spec.takeover and st in ("running", "parked_fg", "parked_settle"):
            ns = s[:]
            ns[i] = ("taken", step, pending, res, ticket, rules == "current")
            if rules == "current":
                p = r["parent"]
                if spec.managed(p) and ns[p][0] != "exited":
                    ps = ns[p]
                    ns[p] = (ps[0], ps[1], ps[2] | {i}, ps[3], ps[4], ps[5])
            emit(ns, seq, f"takeover {i}")
        if st == "taken":
            ns = s[:]
            for c in spec.children(i):
                cancel_tree(ns, c)
            finish(ns, i, notify=rules == "e18")
            emit(ns, seq, f"human closes {i}")
        if spec.cancel and st == "running":
            for c in spec.children(i):
                if s[c][0] in ("queued", "running", "parked_fg", "parked_settle"):
                    ns = s[:]
                    cancel_tree(ns, c)
                    if ns[c][0] == "queued":
                        ns[c] = ("exited", 0, frozenset(), None, None, False)
                    ps = ns[i]
                    ns[i] = (ps[0], ps[1], ps[2] | {c}, ps[3], ps[4], ps[5])
                    emit(ns, seq, f"{i} cancels {c}")

    # One FIFO pass under the lock. Parked runs ready to wake go ahead of every ticket for capacity.
    waking = [w for w in range(spec.n) if wakeable(spec, s, w)] if rules == "current" else []
    older, capacity_line_held = [], False
    for _, t in sorted((s[i][4], i) for i in range(spec.n) if s[i][0] == "queued"):
        if blockers(spec, s, t, rules, older):
            older.append(t)
            continue
        older.append(t)
        if capacity_line_held or waking or not has_slot(spec, s, t, rules):
            capacity_line_held = True
            continue
        ns = s[:]
        res = reservation_for(spec, s, t, rules)
        ns[t] = ("running", 0, frozenset(), res if res is not None else t, None, False)
        emit(ns, seq, f"admit {t}" + (f" into reservation {res}" if res is not None else ""))
        break
    return out


def violations(spec, state):
    s = state[0]
    susp = suspended(spec, s)
    active = [i for i in range(spec.n) if holds(spec, s, i) and i not in susp]
    for a in active:
        for b in active:
            if a < b and overlaps(spec.runs[a]["checkout"], spec.runs[b]["checkout"]) and (spec.runs[a]["access"], spec.runs[b]["access"]) not in COMPAT:
                return f"incompatible active holders {a} and {b}"
    # Only a human (takeover) may push the count past a ceiling; model-driven runs never do.
    model_driven = [i for i in range(spec.n) if spec.managed(i) and s[i][0] == "running"]
    if len(model_driven) > spec.ceiling:
        return f"ceiling exceeded by model-driven runs: {model_driven}"
    for p, cap in spec.providers.items():
        on_p = [i for i in model_driven if spec.runs[i]["provider"] == p]
        if len(on_p) > cap:
            return f"provider {p} ceiling exceeded: {on_p}"
    return None


def check(spec, rules, limit=400000):
    start = initial(spec)
    seen = {start: None}
    q = deque([start])
    while q:
        st = q.popleft()
        v = violations(spec, st)
        if v:
            return "UNSAFE", v, trace(seen, st)
        succ = successors(spec, st, rules)
        if not succ and not all(
                x[0] in ("exited", "refused", "pending") if spec.managed(i) else (x[0] == "running" and x[1] >= len(spec.runs[i]["plan"]))
                for i, x in enumerate(st[0])):
            return "DEADLOCK", {i: x[0] for i, x in enumerate(st[0])}, trace(seen, st)
        for ns, label in succ:
            if ns not in seen:
                seen[ns] = (st, label)
                q.append(ns)
                if len(seen) > limit:
                    return "LIMIT", len(seen), []
    return "OK", len(seen), []


def trace(seen, st):
    out = []
    while seen[st] is not None:
        st, label = seen[st]
        out.append(label)
    return list(reversed(out))
