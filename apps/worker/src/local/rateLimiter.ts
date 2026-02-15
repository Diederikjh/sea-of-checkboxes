export function recordWithinLimit(
  timestamps: number[],
  nowMs: number,
  windowMs: number,
  limit: number
): boolean {
  const minTime = nowMs - windowMs;
  let write = 0;
  for (let read = 0; read < timestamps.length; read += 1) {
    const value = timestamps[read];
    if (value !== undefined && value >= minTime) {
      timestamps[write] = value;
      write += 1;
    }
  }
  timestamps.length = write;

  if (timestamps.length >= limit) {
    return false;
  }

  timestamps.push(nowMs);
  return true;
}
