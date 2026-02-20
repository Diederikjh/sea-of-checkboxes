const STORAGE_KEY = "sea.identity.v1";
const UID_PATTERN = /^u_[A-Za-z0-9]{1,32}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{2,31}$/;

function defaultStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage ?? null;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    return null;
  }

  const uid = typeof identity.uid === "string" ? identity.uid.trim() : "";
  const name = typeof identity.name === "string" ? identity.name.trim() : "";
  if (!UID_PATTERN.test(uid) || !NAME_PATTERN.test(name)) {
    return null;
  }

  return { uid, name };
}

export function readStoredIdentity({ storage = defaultStorage() } = {}) {
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return normalizeIdentity(parsed);
  } catch {
    return null;
  }
}

export function writeStoredIdentity(identity, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return false;
  }

  const normalized = normalizeIdentity(identity);
  if (!normalized) {
    return false;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function isValidIdentity(identity) {
  return normalizeIdentity(identity) !== null;
}
