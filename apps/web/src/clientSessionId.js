const SESSION_STORAGE_KEY = "sea_client_session_id";

function fallbackSessionId(nowFn = () => Date.now(), randomFn = Math.random) {
  const now = nowFn().toString(36);
  const random = Math.floor(randomFn() * 0x100000000).toString(36).padStart(7, "0");
  return `web_${now}_${random}`;
}

function createSessionId(cryptoLike = globalThis.crypto) {
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") {
    return `web_${cryptoLike.randomUUID()}`;
  }
  return fallbackSessionId();
}

export function resolveClientSessionId({
  storage = globalThis.window?.sessionStorage,
  cryptoLike = globalThis.crypto,
} = {}) {
  if (storage && typeof storage.getItem === "function") {
    const existing = storage.getItem(SESSION_STORAGE_KEY);
    if (typeof existing === "string" && existing.trim().length > 0) {
      return existing.trim();
    }
  }

  const sessionId = createSessionId(cryptoLike);
  if (storage && typeof storage.setItem === "function") {
    try {
      storage.setItem(SESSION_STORAGE_KEY, sessionId);
    } catch {
      // Ignore session storage failures in restricted browser contexts.
    }
  }
  return sessionId;
}
