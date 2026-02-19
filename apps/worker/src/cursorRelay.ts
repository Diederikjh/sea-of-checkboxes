import { parseTileKeyStrict } from "@sea/domain";

export interface CursorPresence {
  uid: string;
  name: string;
  x: number;
  y: number;
  seenAt: number;
  seq: number;
  tileKey: string;
}

export interface CursorRelayBatch {
  from: string;
  updates: CursorPresence[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidCursorPresence(value: unknown): value is CursorPresence {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const update = value as Partial<CursorPresence>;
  if (typeof update.uid !== "string" || update.uid.length === 0) {
    return false;
  }
  if (typeof update.name !== "string" || update.name.length === 0) {
    return false;
  }
  if (!isFiniteNumber(update.x) || !isFiniteNumber(update.y)) {
    return false;
  }
  if (typeof update.seq !== "number" || !Number.isInteger(update.seq) || update.seq < 1) {
    return false;
  }
  if (!isFiniteNumber(update.seenAt) || update.seenAt < 0) {
    return false;
  }
  if (typeof update.tileKey !== "string" || parseTileKeyStrict(update.tileKey) === null) {
    return false;
  }

  return true;
}

export function isValidCursorRelayBatch(value: unknown): value is CursorRelayBatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const batch = value as Partial<CursorRelayBatch>;
  if (typeof batch.from !== "string" || batch.from.length === 0) {
    return false;
  }
  if (!Array.isArray(batch.updates)) {
    return false;
  }
  return batch.updates.every((update) => isValidCursorPresence(update));
}
