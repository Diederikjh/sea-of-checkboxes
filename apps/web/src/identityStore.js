import { normalizeIdentity } from "@sea/domain";

const STORAGE_KEY = "sea.identity.v2";
const MAX_TOKEN_LENGTH = 2_048;

function defaultStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage ?? null;
}

export function normalizeStoredIdentity(value) {
  const normalized = normalizeIdentity(value);
  if (!normalized) {
    return null;
  }

  const token = typeof value?.token === "string" ? value.token.trim() : "";
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  return {
    ...normalized,
    token,
  };
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
    return normalizeStoredIdentity(parsed);
  } catch {
    return null;
  }
}

export function writeStoredIdentity(identity, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return false;
  }

  const normalized = normalizeStoredIdentity(identity);
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
