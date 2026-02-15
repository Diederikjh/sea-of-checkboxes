export class LruMap {
  #maxEntries;
  #map;

  constructor(maxEntries) {
    this.#maxEntries = maxEntries;
    this.#map = new Map();
  }

  get size() {
    return this.#map.size;
  }

  get(key) {
    if (!this.#map.has(key)) {
      return undefined;
    }
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    }
    this.#map.set(key, value);

    while (this.#map.size > this.#maxEntries) {
      const oldestKey = this.#map.keys().next().value;
      this.#map.delete(oldestKey);
    }
  }

  has(key) {
    return this.#map.has(key);
  }

  keys() {
    return this.#map.keys();
  }
}
