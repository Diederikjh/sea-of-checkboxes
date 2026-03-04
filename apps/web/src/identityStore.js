import { normalizeIdentity } from "@sea/domain";

const AUTH_STATE_STORAGE_KEY = "sea.auth-state.v1";
const LEGACY_IDENTITY_STORAGE_KEY = "sea.identity.v2";
const LEGACY_ANONYMOUS_STORAGE_KEY = "sea.identity.anon.v1";
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
  return readAuthState({ storage }).active;
}

export function writeStoredIdentity(identity, { storage = defaultStorage() } = {}) {
  const normalized = normalizeStoredIdentity(identity);
  if (!normalized) {
    return false;
  }

  const state = readAuthState({ storage });
  return writeAuthState({
    active: normalized,
    anonymousBackup: state.anonymousBackup,
  }, { storage });
}

export function readStoredAnonymousIdentity({ storage = defaultStorage() } = {}) {
  return readAuthState({ storage }).anonymousBackup;
}

export function writeStoredAnonymousIdentity(identity, { storage = defaultStorage() } = {}) {
  const normalized = normalizeStoredIdentity(identity);
  if (!normalized) {
    return false;
  }

  const state = readAuthState({ storage });
  return writeAuthState({
    active: state.active,
    anonymousBackup: normalized,
  }, { storage });
}

export function clearStoredAnonymousIdentity({ storage = defaultStorage() } = {}) {
  if (!storage) {
    return false;
  }

  const state = readAuthState({ storage });
  return writeAuthState({
    active: state.active,
    anonymousBackup: null,
  }, { storage });
}

function readAuthState({ storage = defaultStorage() } = {}) {
  if (!storage) {
    return {
      active: null,
      anonymousBackup: null,
    };
  }

  const storedState = normalizeAuthState(readJsonValue(storage, AUTH_STATE_STORAGE_KEY));
  if (storedState) {
    return storedState;
  }

  const legacyActive = normalizeStoredIdentity(readJsonValue(storage, LEGACY_IDENTITY_STORAGE_KEY));
  const legacyAnonymous = normalizeStoredIdentity(readJsonValue(storage, LEGACY_ANONYMOUS_STORAGE_KEY));

  return {
    active: legacyActive,
    anonymousBackup: legacyAnonymous,
  };
}

function normalizeAuthState(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const active = normalizeStoredIdentity(value.active);
  const anonymousBackup = normalizeStoredIdentity(value.anonymousBackup);
  return {
    active,
    anonymousBackup,
  };
}

function readJsonValue(storage, key) {
  if (!storage) {
    return null;
  }

  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeAuthState(state, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return false;
  }

  const normalized = normalizeAuthState(state) ?? {
    active: null,
    anonymousBackup: null,
  };

  try {
    storage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({
        active: normalized.active,
        anonymousBackup: normalized.anonymousBackup,
      })
    );
  } catch {
    return false;
  }

  if (typeof storage.removeItem === "function") {
    try {
      storage.removeItem(LEGACY_IDENTITY_STORAGE_KEY);
      storage.removeItem(LEGACY_ANONYMOUS_STORAGE_KEY);
    } catch {
      // Best-effort cleanup only.
    }
  }

  return true;
}
