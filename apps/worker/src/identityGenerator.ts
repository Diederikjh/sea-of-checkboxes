const NAME_ADJECTIVES = ["Brisk", "Quiet", "Amber", "Mint", "Rust", "Blue"];
const NAME_NOUNS = ["Otter", "Falcon", "Badger", "Stoat", "Fox", "Heron"];

function randomFrom<T>(values: T[]): T {
  const index = Math.floor(Math.random() * values.length);
  const value = values[index];
  if (value === undefined) {
    throw new Error("Unable to select random value");
  }
  return value;
}

export function generateUid(): string {
  return `u_${crypto.randomUUID().slice(0, 8)}`;
}

export function generateName(): string {
  const adjective = randomFrom(NAME_ADJECTIVES);
  const noun = randomFrom(NAME_NOUNS);
  const suffix = Math.floor(Math.random() * 1_000)
    .toString()
    .padStart(3, "0");
  return `${adjective}${noun}${suffix}`;
}
