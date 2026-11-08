"""Export every reachable current protocol state and its enabled reporter/owner actions."""
import json
import sys
from collections import deque
from protocol import initial, successors


def actions(labels):
    inbox, settlement = "none", "none"
    for label in labels:
        if label.startswith("reporter accepts"):
            inbox = "steer" if label.endswith("steers") else "prompt"
        elif label.startswith("reporter refuses"):
            inbox = "refuse"
        elif label.startswith("inbox handler accepts"):
            inbox = "defer"
        elif label == "reporter sees cancelled and exits":
            settlement = "exit"
        elif label == "reporter sees claim and stays idle":
            settlement = "stay"
        elif label == "settlement waits for accepted messages":
            settlement = "wait"
        elif label == "reporter claims result and shuts down":
            settlement = "publish"
    return inbox, settlement


def main():
    start = initial()
    seen, queue = {start}, deque([start])
    with open(sys.argv[1], "w", encoding="utf-8") as output:
        while queue:
            state = queue.popleft()
            claim, lock, child, parent, msgs, piq, alive = state
            nxt = successors(state, "current")
            inbox, settlement = actions([label for _, label in nxt])
            output.write(json.dumps({
                "snapshot": {"claim": claim, "lock": lock, "child": child,
                             "messages": msgs, "piQueue": piq},
                "inbox": inbox, "settlement": settlement,
            }, separators=(",", ":")) + "\n")
            for ns, _ in nxt:
                if ns not in seen:
                    seen.add(ns)
                    queue.append(ns)
    print(json.dumps({"states": len(seen), "rules": "current", "messages": len(start[4])}))


if __name__ == "__main__":
    main()
