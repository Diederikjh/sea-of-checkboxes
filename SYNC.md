# Sync Rules

This page explains how checkbox sync works in Sea of Checkboxes.

## 1) One click = one checkbox update

- Each edit you make sends a single checkbox update (`tile + cell + value`).
- The app does not send "set many checkboxes at once" from one click.
- The server may forward updates in small batches for efficiency, but each change is still tracked per checkbox.

## 2) Last write wins

- If two people change the same checkbox close together, the last accepted write becomes the visible state.
- This applies across all users and tabs.
- You may briefly see a value change and then change again if another write arrives after yours.

## 3) Your own rapid clicks keep order

- For one connected client, checkbox writes are processed in send order.
- This prevents your own quick toggles from being reordered on the server.

## 4) Optimistic UI + server truth

- Your click is shown immediately in the UI (optimistic update).
- If the server later confirms a different final value, the UI converges to that server value.
- In practice: a checkbox can "flip back" if a newer conflicting write won.

## 5) Versioned tile updates and self-healing

- Tiles have version numbers.
- The client ignores stale updates and detects missing version gaps.
- If a gap is detected, the client asks for a fresh tile snapshot and resyncs automatically.

## 6) Offline / reconnect behavior

- If connection drops, the app retries unsynced checkbox writes after reconnect.
- Replays are throttled in small batches to avoid reconnect storms.
- The offline banner appears after a delay and shows unsynced count.
- The outbox keeps recent writes and prunes old/expired entries; if you edit the same checkbox multiple times offline, only the latest value is kept for that checkbox.

## 7) Safety limits

- There are rate limits to protect the service from extreme write bursts.
- Very hot tiles can temporarily become read-only.
- In extreme watcher load, new subscriptions to a tile can be denied for a while.

## 8) What this means for users

- Normal editing should feel immediate.
- During heavy contention, the final state is whichever write won last.
- If you reconnect, recent edits are retried and the board converges automatically.
