import fs from "node:fs";
import path from "node:path";

export function createNdjsonLogger(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stream = fs.createWriteStream(outputPath, { flags: "a" });
  let closed = false;
  let closePromise = null;
  let streamError = null;

  stream.on("error", (error) => {
    if (closed && error?.code === "ERR_STREAM_WRITE_AFTER_END") {
      return;
    }
    streamError = error;
  });

  return {
    log(event, fields = {}) {
      if (closed || stream.writableEnded || stream.destroyed) {
        return false;
      }
      stream.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...fields,
      })}\n`);
      return true;
    },
    async close() {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      closePromise = new Promise((resolve, reject) => {
        if (streamError) {
          reject(streamError);
          return;
        }
        stream.end((error) => {
          const finalError = error ?? streamError;
          if (finalError) {
            reject(finalError);
            return;
          }
          resolve();
        });
      });
      await closePromise;
    },
  };
}
