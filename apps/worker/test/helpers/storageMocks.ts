export class NullStorage {
  async get<T>(_key: string): Promise<T | undefined> {
    return undefined;
  }

  async put<T>(_key: string, _value: T): Promise<void> {}
}

export class MemoryStorage {
  #data: Map<string, unknown>;

  constructor() {
    this.#data = new Map();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, value);
  }
}
