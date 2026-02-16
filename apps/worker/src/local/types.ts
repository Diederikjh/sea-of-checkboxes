import type { ServerMessage } from "@sea/protocol";

export type ClientSink = (payload: Uint8Array) => void;

/** @deprecated Prefer `ClientSink` and binary wire payloads. */
export type JsonClientSink = (message: ServerMessage) => void;

export type TileSnapshotMessage = Extract<ServerMessage, { t: "tileSnap" }>;
export type TileBatchMessage = Extract<ServerMessage, { t: "cellUpBatch" }>;

export interface TileWatcher {
  id: string;
  receiveTileBatch(message: TileBatchMessage): void;
}
