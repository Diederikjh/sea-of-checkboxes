import { describe, expect, it } from "vitest";

import {
  buildCursorFirstLocalPublishLogFields,
  buildCursorLocalPublishLogFields,
} from "../src/connectionShardCursorLogFields";

describe("connection shard cursor log fields", () => {
  it("includes shared local cursor publish fields", () => {
    const client = {
      uid: "u_a",
      name: "Alice",
      clientSessionId: "session-a",
      socket: {} as never,
      subscribed: new Set(["0:0"]),
    };

    expect(
      buildCursorLocalPublishLogFields({
        client,
        connectionAgeMs: 123,
        cursor: {
          uid: "u_a",
          seq: 7,
          tileKey: "0:0",
          x: 4.5,
          y: -2.5,
        },
        fanoutCount: 3,
      })
    ).toEqual({
      uid: "u_a",
      client_session_id: "session-a",
      seq: 7,
      tile: "0:0",
      x: 4.5,
      y: -2.5,
      fanout_count: 3,
      connection_age_ms: 123,
    });
  });

  it("adds subscribed count for the first local cursor publish event", () => {
    const client = {
      uid: "u_b",
      name: "Bob",
      socket: {} as never,
      subscribed: new Set(["0:0", "1:0"]),
    };

    expect(
      buildCursorFirstLocalPublishLogFields({
        client,
        cursor: {
          uid: "u_b",
          seq: 1,
          tileKey: "1:0",
          x: 10,
          y: 12,
        },
        fanoutCount: 0,
      })
    ).toEqual({
      uid: "u_b",
      seq: 1,
      tile: "1:0",
      x: 10,
      y: 12,
      fanout_count: 0,
      subscribed_count: 2,
    });
  });
});
