export const SHARD_COUNT = 8;

export function shardNameForUid(uid: string): string {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const shard = Math.abs(hash) % SHARD_COUNT;
  return `shard-${shard}`;
}

export function peerShardNames(currentShard: string): string[] {
  const match = /^shard-(\d+)$/.exec(currentShard);
  if (!match) {
    return [];
  }

  const peers: string[] = [];
  for (let index = 0; index < SHARD_COUNT; index += 1) {
    const shard = `shard-${index}`;
    if (shard === currentShard) {
      continue;
    }
    peers.push(shard);
  }
  return peers;
}
