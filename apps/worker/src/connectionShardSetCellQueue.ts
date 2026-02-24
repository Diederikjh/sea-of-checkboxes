export class ConnectionShardSetCellQueue {
  #chainsByUid: Map<string, Promise<void>>;

  constructor() {
    this.#chainsByUid = new Map();
  }

  async enqueue(uid: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#chainsByUid.get(uid) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Keep queue progressing after prior failure.
      })
      .then(task);

    this.#chainsByUid.set(uid, next);
    try {
      await next;
    } finally {
      if (this.#chainsByUid.get(uid) === next) {
        this.#chainsByUid.delete(uid);
      }
    }
  }

  clear(uid: string): void {
    this.#chainsByUid.delete(uid);
  }
}
