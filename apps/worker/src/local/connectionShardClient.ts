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

export function sendClientError(client: ClientRecord, code: string, msg: string): void {
  client.sink({
    t: "err",
    code,
    msg,
  });
}
