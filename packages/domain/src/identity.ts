export interface Identity {
  uid: string;
  name: string;
}

export const UID_PATTERN = /^u_[A-Za-z0-9]{1,32}$/;
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{2,31}$/;

export function normalizeIdentity(value: unknown): Identity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { uid?: unknown; name?: unknown };
  const uid = typeof candidate.uid === "string" ? candidate.uid.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!UID_PATTERN.test(uid) || !NAME_PATTERN.test(name)) {
    return null;
  }

  return { uid, name };
}

export function isValidIdentity(value: unknown): value is Identity {
  return normalizeIdentity(value) !== null;
}
