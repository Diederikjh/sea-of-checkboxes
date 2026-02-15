import { TileOwner } from "./tileOwner";

export class LocalRealtimeRuntime {
  #owners: Map<string, TileOwner>;

  constructor() {
    this.#owners = new Map();
  }

  getTileOwner(tileKey: string): TileOwner {
    let owner = this.#owners.get(tileKey);
    if (!owner) {
      owner = new TileOwner(tileKey);
      this.#owners.set(tileKey, owner);
    }
    return owner;
  }

  ownerCount(): number {
    return this.#owners.size;
  }
}
