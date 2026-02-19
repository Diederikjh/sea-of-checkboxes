import { MAX_REMOTE_CURSORS } from "@sea/domain";

export interface CursorSelectionClient {
  uid: string;
  subscribed: Set<string>;
  lastCursorX?: number | null;
  lastCursorY?: number | null;
}

export interface CursorSelectionState {
  uid: string;
  x: number;
  y: number;
  seenAt: number;
  tileKey: string;
}

export interface CursorSelectionParams {
  client: CursorSelectionClient;
  cursorByUid: Map<string, CursorSelectionState>;
  cursorTileIndex: Map<string, Set<string>>;
  nowMs: number;
  cursorTtlMs: number;
  nearestLimit?: number;
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function getReferencePoint(client: CursorSelectionClient): { x: number; y: number } | null {
  const x = client.lastCursorX;
  const y = client.lastCursorY;
  if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
    return {
      x,
      y,
    };
  }
  return null;
}

function isCursorFresh(state: CursorSelectionState, nowMs: number, cursorTtlMs: number): boolean {
  return nowMs - state.seenAt <= cursorTtlMs;
}

export function selectCursorSubscriptions(params: CursorSelectionParams): string[] {
  const reference = getReferencePoint(params.client);
  if (!reference) {
    return [];
  }

  const limit = params.nearestLimit ?? MAX_REMOTE_CURSORS;
  const candidates = new Set<string>();

  for (const tileKey of params.client.subscribed) {
    const tileUids = params.cursorTileIndex.get(tileKey);
    if (!tileUids) {
      continue;
    }
    for (const uid of tileUids) {
      candidates.add(uid);
    }
  }

  // If nearby subscribed tiles have few cursors, include global actives.
  if (candidates.size < limit) {
    for (const [uid, state] of params.cursorByUid) {
      if (!isCursorFresh(state, params.nowMs, params.cursorTtlMs)) {
        continue;
      }
      candidates.add(uid);
    }
  }

  return Array.from(candidates)
    .filter((uid) => {
      if (uid === params.client.uid) {
        return false;
      }
      const state = params.cursorByUid.get(uid);
      if (!state) {
        return false;
      }
      return isCursorFresh(state, params.nowMs, params.cursorTtlMs);
    })
    .sort((leftUid, rightUid) => {
      const left = params.cursorByUid.get(leftUid);
      const right = params.cursorByUid.get(rightUid);
      if (!left || !right) {
        return 0;
      }

      const leftDistance = squaredDistance(left.x, left.y, reference.x, reference.y);
      const rightDistance = squaredDistance(right.x, right.y, reference.x, reference.y);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      return right.seenAt - left.seenAt;
    })
    .slice(0, limit);
}
