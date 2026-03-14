export const CURSOR_PULL_TIMING = Object.freeze({
  intervalMinMs: 75,
  intervalMaxMs: 300,
  intervalBackoffStepMs: 75,
  intervalIdleMaxMs: 1_500,
  intervalIdleBackoffStepMs: 300,
  idleStreakBeforeLongBackoff: 4,
  activityWindowMs: 500,
  jitterMs: 25,
  concurrency: 2,
});

export const CURSOR_HUB_WATCH_TIMING = Object.freeze({
  renewMs: 60_000,
  probeRenewMs: 500,
  settleWindowMs: 5_000,
});

export function defaultCursorHubSettleRenewMs(): number {
  return CURSOR_HUB_WATCH_TIMING.probeRenewMs;
}
