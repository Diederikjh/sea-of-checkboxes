const LOCAL_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

export function buildWorkerHealthUrl(wsUrl) {
  const parsed = new URL(wsUrl);
  const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${parsed.host}/health`;
}

export function shouldWaitForWorkerReadiness(wsUrl) {
  const parsed = new URL(wsUrl);
  return parsed.protocol === "ws:" && LOCAL_HOSTNAMES.has(parsed.hostname);
}

export async function waitForWorkerReady({
  wsUrl,
  runId,
  logger,
  fetchImpl = fetch,
  nowMs = () => Date.now(),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  timeoutMs = 10_000,
  pollIntervalMs = 250,
} = {}) {
  if (!shouldWaitForWorkerReadiness(wsUrl)) {
    return {
      ok: true,
      skipped: true,
      reason: "non_local_worker",
    };
  }

  const healthUrl = buildWorkerHealthUrl(wsUrl);
  const startedAtMs = nowMs();
  const deadlineMs = startedAtMs + timeoutMs;
  let attempts = 0;
  logger?.log("worker_readiness_wait_start", {
    runId,
    wsUrl,
    healthUrl,
    timeoutMs,
    pollIntervalMs,
  });

  while (nowMs() <= deadlineMs) {
    attempts += 1;
    try {
      const response = await fetchImpl(healthUrl);
      const payload = await response.json();
      if (response.ok && payload?.ok === true) {
        const result = {
          ok: true,
          skipped: false,
          attempts,
          healthUrl,
          elapsedMs: Math.max(0, nowMs() - startedAtMs),
        };
        logger?.log("worker_readiness_ready", {
          runId,
          ...result,
        });
        return result;
      }
    } catch {
      // Retry until timeout.
    }

    if (nowMs() >= deadlineMs) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  const result = {
    ok: false,
    skipped: false,
    attempts,
    healthUrl,
    elapsedMs: Math.max(0, nowMs() - startedAtMs),
  };
  logger?.log("worker_readiness_timeout", {
    runId,
    ...result,
  });
  return result;
}
