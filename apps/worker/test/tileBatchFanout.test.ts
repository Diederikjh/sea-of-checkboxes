import type { ServerMessage } from "@sea/protocol";
import { describe, expect, it } from "vitest";

import { fanoutTileBatchToSubscribers } from "../src/tileBatchFanout";

interface ClientLike {
  uid: string;
}

describe("tile batch fanout", () => {
  it("fans out only to subscribed and connected clients", () => {
    const clients = new Map<string, ClientLike>([
      ["u_a", { uid: "u_a" }],
      ["u_b", { uid: "u_b" }],
    ]);
    const tileToClients = new Map<string, Set<string>>([
      ["0:0", new Set(["u_a", "u_missing"])],
    ]);
    const sent: string[] = [];
    const batch: Extract<ServerMessage, { t: "cellUpBatch" }> = {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[2, 1]],
    };

    fanoutTileBatchToSubscribers({
      message: batch,
      tileToClients,
      clients,
      sendServerMessage(client) {
        sent.push(client.uid);
      },
    });

    expect(sent).toEqual(["u_a"]);
  });

  it("no-ops when tile has no subscribers", () => {
    const clients = new Map<string, ClientLike>([["u_a", { uid: "u_a" }]]);
    const tileToClients = new Map<string, Set<string>>();
    const sent: string[] = [];
    const batch: Extract<ServerMessage, { t: "cellUpBatch" }> = {
      t: "cellUpBatch",
      tile: "0:0",
      fromVer: 1,
      toVer: 1,
      ops: [[2, 1]],
    };

    fanoutTileBatchToSubscribers({
      message: batch,
      tileToClients,
      clients,
      sendServerMessage(client) {
        sent.push(client.uid);
      },
    });

    expect(sent).toEqual([]);
  });
});
