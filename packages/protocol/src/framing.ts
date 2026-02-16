const FRAME_HEADER_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface DecodeFramesOptions {
  maxFrameBytes?: number;
}

export interface DecodeFramesResult {
  frames: Uint8Array[];
  remainder: Uint8Array;
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, payload.length);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeFrames(
  chunk: Uint8Array,
  options: DecodeFramesOptions = {}
): DecodeFramesResult {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const frames: Uint8Array[] = [];

  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= chunk.length) {
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset + offset,
      FRAME_HEADER_BYTES
    );

    const frameLength = view.getUint32(0);
    if (frameLength > maxFrameBytes) {
      throw new Error(`Frame length ${frameLength} exceeds max ${maxFrameBytes}`);
    }

    const frameEnd = offset + FRAME_HEADER_BYTES + frameLength;
    if (frameEnd > chunk.length) {
      break;
    }

    frames.push(chunk.slice(offset + FRAME_HEADER_BYTES, frameEnd));
    offset = frameEnd;
  }

  return {
    frames,
    remainder: chunk.slice(offset),
  };
}
