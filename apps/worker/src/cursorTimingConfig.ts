export interface CursorPullBackoffProfile {
  intervalMaxMs: number;
  intervalBackoffStepMs: number;
}

export const CURSOR_PULL_TIMING = Object.freeze({
  intervalMinMs: 75,
  intervalIdleMaxMs: 1_500,
  intervalIdleBackoffStepMs: 300,
  idleStreakBeforeLongBackoff: 4,
  activityWindowMs: 500,
  jitterMs: 25,
  concurrency: 2,
});

const SINGLE_PEER_CURSOR_PULL_BACKOFF_PROFILE = Object.freeze({
  intervalMaxMs: 125,
  intervalBackoffStepMs: 25,
} satisfies CursorPullBackoffProfile);

const MULTI_PEER_CURSOR_PULL_BACKOFF_PROFILE = Object.freeze({
  intervalMaxMs: 225,
  intervalBackoffStepMs: 50,
} satisfies CursorPullBackoffProfile);

export function cursorPullBackoffProfileForPeerCount(peerCount: number): CursorPullBackoffProfile {
  return peerCount <= 1
    ? SINGLE_PEER_CURSOR_PULL_BACKOFF_PROFILE
    : MULTI_PEER_CURSOR_PULL_BACKOFF_PROFILE;
}

export const CURSOR_HUB_WATCH_TIMING = Object.freeze({
  renewMs: 60_000,
  probeRenewMs: 500,
  settleWindowMs: 5_000,
});

export function defaultCursorHubSettleRenewMs(): number {
  return CURSOR_HUB_WATCH_TIMING.probeRenewMs;
}
