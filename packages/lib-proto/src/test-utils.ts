/**
 * Polls `fn` until it returns a truthy value or the timeout expires.
 * ProcessManager has no "ready" signal, so tests wait on observable state.
 */
export const waitFor = async <T>(fn: () => T, timeout_ms = 2_000, interval_ms = 10): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval_ms));
  }
  throw new Error(`waitFor: condition not met within ${timeout_ms}ms`);
};
