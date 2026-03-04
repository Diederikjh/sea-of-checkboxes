import { normalizeIdentity } from "@sea/domain";

const STORAGE_KEY = "sea.identity.v2";
const ANONYMOUS_STORAGE_KEY = "sea.identity.anon.v1";
const MAX_TOKEN_LENGTH = 2_048;

function defaultStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage ?? window.localStorage ?? null;
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
  return readStoredIdentityByKey(STORAGE_KEY, { storage });
}

export function writeStoredIdentity(identity, { storage = defaultStorage() } = {}) {
  return writeStoredIdentityByKey(STORAGE_KEY, identity, { storage });
}

export function readStoredAnonymousIdentity({ storage = defaultStorage() } = {}) {
  return readStoredIdentityByKey(ANONYMOUS_STORAGE_KEY, { storage });
}

export function writeStoredAnonymousIdentity(identity, { storage = defaultStorage() } = {}) {
  return writeStoredIdentityByKey(ANONYMOUS_STORAGE_KEY, identity, { storage });
}

export function clearStoredAnonymousIdentity({ storage = defaultStorage() } = {}) {
  if (!storage || typeof storage.removeItem !== "function") {
    return false;
  }

  try {
    storage.removeItem(ANONYMOUS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function readStoredIdentityByKey(key, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return normalizeStoredIdentity(parsed);
  } catch {
    return null;
  }
}

function writeStoredIdentityByKey(key, identity, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return false;
  }

  const normalized = normalizeStoredIdentity(identity);
  if (!normalized) {
    return false;
  }

  try {
    storage.setItem(key, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}
