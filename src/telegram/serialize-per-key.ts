/**
 * One shared implementation of the per-key promise-chain pattern that keeps
 * same-key async work strictly ordered (per chat, per lane) without letting a
 * rejected task poison the lane for everyone queued behind it.
 *
 * Historically every call site hand-rolled this pattern (five copies, three
 * private `noop`s), and copy drift across those twins was the source of
 * several race defects — they now all delegate here (audit R3-2).
 */

/** Swallow a chain result so the stored lane promise never rejects while it
 * sits idle in the map (which would surface as an unhandled rejection). */
export function noop(): void {
  /* keep the chain flowing after rejections */
}

/** Run `run` after every previously enqueued task for `key` has SETTLED.
 *
 * The map stores only the swallowed settlement twin of the caller's promise,
 * so a failing task never wedges later ones, and a settled entry is removed
 * while it is still the lane's tail (identity-checked, so a task enqueued in
 * the meantime is never dropped) — per-chat maps stay bounded. The caller
 * still receives the task's own outcome: fulfillment and rejection both
 * propagate. */
export function serializePerKey<K extends string | number, T>(
  map: Map<K, Promise<unknown>>,
  key: K,
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = map.get(key) ?? Promise.resolve();
  const pending = previous.then(run, run);
  const settled = pending.then(noop, noop);
  map.set(key, settled);
  void settled.then(() => {
    if (map.get(key) === settled) map.delete(key);
  });
  return pending;
}
