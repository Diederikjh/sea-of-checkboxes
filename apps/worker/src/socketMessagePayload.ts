export function toBinaryPayload(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

export function readMessageEventData(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  if (!("data" in event)) {
    return null;
  }
  return (event as { data: unknown }).data;
}

export function readBinaryMessageEventPayload(event: unknown): Uint8Array | null {
  return toBinaryPayload(readMessageEventData(event));
}
