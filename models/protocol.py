"""Exhaustive model of one run's claim, lock, inbox, settlement, takeover, and cancellation.

RULES="current" follows ../docs/design.md. RULES="e19" is the first E19 correction,
whose settlement checked descendant outcomes but not accepted messages, and whose reporter
stayed alive under any claim it did not write.

Invariants:
- A run whose claim is `result` consumed every message the parent was told was accepted.
- No message is accepted after a claim exists.
- A `cancelled` run's process exits. Nothing ends in a stuck state.
"""
import itertools, sys
from collections import deque

MSGS = 2


def initial():
    # claim, lock holder, child phase, parent phase, message states, Pi queue, parent alive
    return (None, None, "working", "idle", ("none",) * MSGS, (), True)


def successors(state, rules):
    claim, lock, child, parent, msgs, piq, alive = state
    out = []

    def emit(label, **kw):
        d = dict(claim=claim, lock=lock, child=child, parent=parent, msgs=msgs, piq=piq, alive=alive)
        d.update(kw)
        out.append(((d["claim"], d["lock"], d["child"], d["parent"], d["msgs"], d["piq"], d["alive"]), label))

    def setm(i, v, base=None):
        m = list(base if base is not None else msgs)
        m[i] = v
        return tuple(m)

    if child == "exited":
        return out
    # The parent writes a message under the lock, or cancels under the lock.
    if alive and lock is None and parent == "idle":
        for i in range(MSGS):
            if msgs[i] == "none":
                emit(f"parent writes m{i}", lock="parent", parent=f"writing{i}")
        if claim is None:
            emit("parent claims cancelled", lock="parent", parent="cancelling", claim="cancelled")
    if alive and lock == "parent" and parent.startswith("writing"):
        i = int(parent[-1])
        emit(f"parent releases after m{i}", lock=None, parent="idle", msgs=setm(i, "written"))
    if alive and lock == "parent" and parent == "cancelling":
        emit("parent signals and releases", lock=None, parent="idle", child="exiting")
    # The parent can crash at any point. Stale recovery frees a lock it held.
    if alive:
        emit("parent crashes", alive=False, lock=None if lock == "parent" else lock)
    # The child reporter accepts or refuses written messages under the lock.
    if lock is None and child in ("working", "idle") and "written" in msgs:
        i = msgs.index("written")
        if claim is None:
            if child == "working":
                emit(f"reporter accepts m{i} and steers", msgs=setm(i, "sent"), piq=piq + (i,))
            else:
                emit(f"reporter accepts m{i} and prompts", msgs=setm(i, "sent"), piq=piq + (i,), child="working")
        else:
            emit(f"reporter refuses m{i}", msgs=setm(i, "refused"))
    # Pi consumes queued messages while a turn runs.
    if child == "working" and piq:
        i = piq[0]
        emit(f"Pi consumes m{i}", piq=piq[1:], msgs=setm(i, "consumed"))
    # The turn ends and Pi emits agent_settled.
    if child == "working" and not piq:
        emit("agent_settled", child="settling")
    # While settling, a message accepted by the inbox handler is deferred by Pi until handlers finish.
    if child == "settling" and lock is None and "written" in msgs and claim is None:
        i = msgs.index("written")
        emit(f"inbox handler accepts m{i} during settlement", msgs=setm(i, "sent"), piq=piq + (i,))
    # The settlement owner decides under the lock.
    if child == "settling" and lock is None:
        unconsumed = [i for i in range(MSGS) if msgs[i] == "sent"]
        if claim == "cancelled" and rules == "current":
            emit("reporter sees cancelled and exits", child="exited")
        elif claim is not None:
            emit("reporter sees claim and stays idle", child="idle")
        elif unconsumed and rules == "current":
            emit("settlement waits for accepted messages", child="working")
        else:
            emit("reporter claims result and shuts down", claim="result", child="shutdown", lock=None)
    if child == "shutdown":
        emit("process exits", child="exited", piq=())
    if child == "exiting":
        emit("process exits on signal", child="exited", piq=())
    # The human takes over under the lock.
    if lock is None and claim is None and child in ("working", "settling", "idle"):
        emit("human takes over", claim="taken_over", child="human")
    if child == "human":
        emit("human closes", child="exited", piq=())
    # An idle child with nothing to do and a cancelled claim is cancelled by any live parent's retry.
    if child == "idle" and claim == "cancelled" and alive:
        emit("parent retries the signal", child="exited")
    return out


def violations(state):
    claim, lock, child, parent, msgs, piq, alive = state
    if claim == "result" and any(m == "sent" for m in msgs):
        return "result claimed while an accepted message was unconsumed"
    return None


def check(rules):
    """Explore every state and return the first trace of each failure kind."""
    start = initial()
    seen, q, found = {start: None}, deque([start]), {}
    while q:
        st = q.popleft()
        v = violations(st)
        if v and "UNSAFE" not in found:
            found["UNSAFE"] = (v, trace(seen, st))
        succ = successors(st, rules)
        if not succ and st[2] != "exited" and "STUCK" not in found:
            found["STUCK"] = (st, trace(seen, st))
        for ns, label in succ:
            if ns not in seen:
                seen[ns] = (st, label)
                q.append(ns)
    return found, len(seen)


def trace(seen, st):
    out = []
    while seen[st] is not None:
        st, label = seen[st]
        out.append(label)
    return list(reversed(out))


if __name__ == "__main__":
    failed = 0
    for rules, want in (("e19", {"UNSAFE", "STUCK"}), ("current", set())):
        found, n = check(rules)
        ok = set(found) == want
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} protocol {rules:8} expected {sorted(want) or 'OK'} got {sorted(found) or 'OK'} over {n} states")
        for kind, (what, tr) in found.items():
            print(f"     {kind}: {what}")
            print("       trace:", " -> ".join(tr))
    sys.exit(1 if failed else 0)
