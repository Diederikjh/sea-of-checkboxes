import {
  decodeRle64,
  parseServerMessage,
} from "@sea/protocol";

export function createServerMessageHandler({
  identityEl,
  setStatus,
  tileStore,
  heatStore,
  transport,
  cursors,
  selfIdentity,
}) {
  return (rawMessage) => {
    const message = parseServerMessage(rawMessage);

    switch (message.t) {
      case "hello": {
        selfIdentity.uid = message.uid;
        identityEl.textContent = `You are ${message.name} (${message.uid})`;
        break;
      }
      case "tileSnap": {
        const bits = decodeRle64(message.bits);
        tileStore.setSnapshot(message.tile, bits, message.ver);
        heatStore.ensureTile(message.tile);
        break;
      }
      case "cellUp": {
        const result = tileStore.applySingle(message.tile, message.i, message.v, message.ver);
        if (result.gap) {
          transport.send({ t: "resyncTile", tile: message.tile, haveVer: Math.max(0, result.haveVer) });
        } else {
          heatStore.bump(message.tile, message.i, Date.now());
        }
        break;
      }
      case "cellUpBatch": {
        const result = tileStore.applyBatch(message.tile, message.fromVer, message.toVer, message.ops);
        if (result.gap) {
          transport.send({ t: "resyncTile", tile: message.tile, haveVer: Math.max(0, result.haveVer) });
        } else {
          const now = Date.now();
          for (const [index] of message.ops) {
            heatStore.bump(message.tile, index, now);
          }
        }
        break;
      }
      case "curUp": {
        if (selfIdentity.uid && message.uid === selfIdentity.uid) {
          break;
        }

        const seenAt = Date.now();
        const current = cursors.get(message.uid);
        if (current) {
          current.name = message.name;
          current.x = message.x;
          current.y = message.y;
          current.seenAt = seenAt;
        } else {
          cursors.set(message.uid, {
            uid: message.uid,
            name: message.name,
            x: message.x,
            y: message.y,
            drawX: message.x,
            drawY: message.y,
            seenAt,
          });
        }
        break;
      }
      case "err": {
        setStatus(`Error: ${message.msg}`);
        break;
      }
      default:
        break;
    }
  };
}
