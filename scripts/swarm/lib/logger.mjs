import fs from "node:fs";
import path from "node:path";

export function createNdjsonLogger(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stream = fs.createWriteStream(outputPath, { flags: "a" });

  return {
    log(event, fields = {}) {
      stream.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...fields,
      })}\n`);
    },
    async close() {
      await new Promise((resolve, reject) => {
        stream.end((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

