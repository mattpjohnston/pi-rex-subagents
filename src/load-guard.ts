interface Events {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

const channel = "pi-rex-subagents:runtime";

function record(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
}

/**
 * A second factory call in this runtime is a no-op. Reload invalidates the runtime and
 * unsubscribes this listener, so the reloaded factory claims the bus again.
 */
export function claimRuntime(events: Events): boolean {
  let claimed = false;
  const probe = events.on(channel, (data) => {
    if (record(data)?.pong === true) claimed = true;
  });
  events.emit(channel, { ping: true });
  probe();
  if (claimed) return false;
  events.on(channel, (data) => {
    if (record(data)?.ping === true) events.emit(channel, { pong: true });
  });
  return true;
}
