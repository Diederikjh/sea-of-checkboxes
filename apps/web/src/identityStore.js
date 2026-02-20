import { isValidIdentity as isValidIdentityFromDomain, normalizeIdentity } from "@sea/domain";

const STORAGE_KEY = "sea.identity.v1";

function defaultStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage ?? null;
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
  return isValidIdentityFromDomain(identity);
}
