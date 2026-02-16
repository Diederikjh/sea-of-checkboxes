import {
  encodeServerMessageBinary,
  type ServerMessage,
} from "@sea/protocol";

import type { ClientSink } from "./types";

export interface ClientRecord {
  uid: string;
  name: string;
  sink: ClientSink;
  subscribed: Set<string>;
  churnTimestamps: number[];
  setCellBurstTimestamps: number[];
  setCellSustainedTimestamps: number[];
}

export function createClientRecord(uid: string, name: string, sink: ClientSink): ClientRecord {
  return {
    uid,
    name,
    sink,
    subscribed: new Set(),
    churnTimestamps: [],
    setCellBurstTimestamps: [],
    setCellSustainedTimestamps: [],
  };
}

export function sendServerMessage(client: ClientRecord, message: ServerMessage): void {
  client.sink(encodeServerMessageBinary(message));
}

export function sendClientError(client: ClientRecord, code: string, msg: string): void {
  sendServerMessage(client, {
    t: "err",
    code,
    msg,
  });
}
