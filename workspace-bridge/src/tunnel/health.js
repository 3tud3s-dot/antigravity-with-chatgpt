const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function tunnelIsHealthy(runtime, workspaceId, options = {}) {
  if (!runtime?.publicUrl) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  try {
    const response = await fetchImpl(`${runtime.publicUrl}/health`, {
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const body = await response.json();
    return response.ok && body.workspaceId === workspaceId && body.status === "ok";
  } catch {
    return false;
  }
}

export async function localTunnelIsReady(runtime, options = {}) {
  const port = Number(runtime?.tunnelMetricsPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForTunnel(runtime, workspaceId, options = {}) {
  if (!runtime?.publicUrl) return false;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const remaining = deadline - now();
    if (await tunnelIsHealthy(runtime, workspaceId, {
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: Math.max(1, Math.min(requestTimeoutMs, remaining))
    })) {
      return true;
    }

    const waitMs = Math.min(intervalMs, deadline - now());
    if (waitMs > 0) await sleep(waitMs);
  }
  return false;
}

export async function tunnelIsReadyForSetup(runtime, workspaceId, options = {}) {
  if (!runtime?.publicUrl) return false;
  const { platform: _platform, ...waitOptions } = options;
  if (runtime.tunnelMetricsPort) {
    const timeoutMs = waitOptions.timeoutMs ?? 30_000;
    const intervalMs = waitOptions.intervalMs ?? 500;
    const now = waitOptions.now ?? Date.now;
    const sleep = waitOptions.sleep ?? delay;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (await localTunnelIsReady(runtime, waitOptions)) return true;
      const waitMs = Math.min(intervalMs, Math.max(0, deadline - now()));
      if (waitMs > 0) await sleep(waitMs);
    }
    return false;
  }
  return waitForTunnel(runtime, workspaceId, waitOptions);
}
