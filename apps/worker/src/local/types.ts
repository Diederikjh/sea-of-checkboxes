import type { ServerMessage } from "@sea/protocol";

export type ClientSink = (message: ServerMessage) => void;

export type TileSnapshotMessage = Extract<ServerMessage, { t: "tileSnap" }>;
export type TileBatchMessage = Extract<ServerMessage, { t: "cellUpBatch" }>;

export interface TileWatcher {
  id: string;
  receiveTileBatch(message: TileBatchMessage): void;
}
