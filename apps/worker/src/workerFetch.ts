import {
  MIN_CELL_PX,
  UID_PATTERN,
  clampCameraCenter,
  isCellIndexValid,
} from "@sea/domain";

import {
  isWebSocketUpgrade,
  isValidTileKey,
  jsonResponse,
  readJson,
  type ConnectionIdentity,
  type Env,
} from "./doCommon";
import { resolveAuthMode } from "./auth/authMode";
import { AccountLinkDORepository } from "./auth/accountLinkDORepository";
import { DefaultAuthSessionService, AuthSessionServiceError } from "./auth/authSessionService";
import { FirebaseIdTokenVerifier } from "./auth/firebaseIdTokenVerifier";
import { parseAuthSessionRequest } from "./auth/requestParsing";
import {
  createIdentityToken,
  resolveIdentitySigningSecret,
  verifyIdentityToken,
} from "./identityToken";
import { generateName, generateUid } from "./identityGenerator";
import { shardNameForUid } from "./sharding";
const CELL_LAST_EDIT_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const AUTH_SESSION_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const SHARE_LINK_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};
const SHARE_LINK_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_LINK_KEY_PREFIX = "share:";
const SHARE_LINK_TTL_SECONDS = 90 * 24 * 60 * 60;
const SHARE_LINK_MAX_ZOOM = 64;
const WS_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const CLIENT_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ShareLinkRecord {
  x: number;
  y: number;
  zoom: number;
  createdAtMs: number;
  lastAccessAtMs: number;
  creatorUid: string | null;
}

interface ShareLinkCreatePayload {
  x?: unknown;
  y?: unknown;
  zoom?: unknown;
}

function buildShardUrl(identity: ConnectionIdentity, shardName: string): URL {
  const shardUrl = new URL("https://connection-shard.internal/ws");
  shardUrl.searchParams.set("uid", identity.uid);
  shardUrl.searchParams.set("name", identity.name);
  shardUrl.searchParams.set("token", identity.token);
  shardUrl.searchParams.set("shard", shardName);
  if (typeof identity.clientSessionId === "string" && identity.clientSessionId.length > 0) {
    shardUrl.searchParams.set("clientSessionId", identity.clientSessionId);
  }
  return shardUrl;
}

function resolveClientSessionId(url: URL): string | undefined {
  const raw = url.searchParams.get("clientSessionId")?.trim() ?? "";
  return CLIENT_SESSION_ID_PATTERN.test(raw) ? raw : undefined;
}

async function resolveIdentity(url: URL, env: Env): Promise<ConnectionIdentity | null> {
  const requestedToken = url.searchParams.get("token")?.trim() ?? "";
  const clientSessionId = resolveClientSessionId(url);
  const signingSecret = resolveIdentitySigningSecret(env);
  const authMode = resolveAuthMode(env);

  if (requestedToken.length > 0) {
    const verifiedIdentity = await verifyIdentityToken({
      token: requestedToken,
      secret: signingSecret,
    });
    if (verifiedIdentity) {
      const token = await createIdentityToken(verifiedIdentity.uid, verifiedIdentity.name, signingSecret);
      return {
        uid: verifiedIdentity.uid,
        name: verifiedIdentity.name,
        token,
        ...(clientSessionId ? { clientSessionId } : {}),
      };
    }
  }

  if (authMode === "firebase_only") {
    return null;
  }

  const uid = generateUid();
  const name = generateName();
  return {
    uid,
    name,
    token: await createIdentityToken(uid, name, signingSecret),
    ...(clientSessionId ? { clientSessionId } : {}),
  };
}

function withCellLastEditCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CELL_LAST_EDIT_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cellLastEditCorsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CELL_LAST_EDIT_CORS_HEADERS,
  });
}

function withAuthSessionCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(AUTH_SESSION_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function authSessionCorsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: AUTH_SESSION_CORS_HEADERS,
  });
}

function withShareLinkCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SHARE_LINK_CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function shareLinkCorsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: SHARE_LINK_CORS_HEADERS,
  });
}

function shareLinkKey(id: string): string {
  return `${SHARE_LINK_KEY_PREFIX}${id.toLowerCase()}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWebSocketTemporarilyDisabled(env: Env): boolean {
  if (typeof env.WS_DISABLED !== "string") {
    return false;
  }

  return WS_DISABLED_VALUES.has(env.WS_DISABLED.trim().toLowerCase());
}

function parseShareLinkCreatePayload(value: unknown): { x: number; y: number; zoom: number } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as ShareLinkCreatePayload;
  if (!isFiniteNumber(payload.x) || !isFiniteNumber(payload.y) || !isFiniteNumber(payload.zoom)) {
    return null;
  }

  const clampedCenter = clampCameraCenter(payload.x, payload.y);
  return {
    x: clampedCenter.x,
    y: clampedCenter.y,
    zoom: Math.max(MIN_CELL_PX, Math.min(SHARE_LINK_MAX_ZOOM, payload.zoom)),
  };
}

function parseShareLinkRecord(raw: string | null): ShareLinkRecord | null {
  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as Partial<ShareLinkRecord>;
    if (
      !isFiniteNumber(value.x) ||
      !isFiniteNumber(value.y) ||
      !isFiniteNumber(value.zoom) ||
      !isFiniteNumber(value.createdAtMs) ||
      !isFiniteNumber(value.lastAccessAtMs)
    ) {
      return null;
    }
    const creatorUidRaw = (value as { creatorUid?: unknown }).creatorUid;
    const creatorUid =
      typeof creatorUidRaw === "string" && UID_PATTERN.test(creatorUidRaw) ? creatorUidRaw : null;
    const clampedCenter = clampCameraCenter(value.x, value.y);
    return {
      x: clampedCenter.x,
      y: clampedCenter.y,
      zoom: Math.max(MIN_CELL_PX, Math.min(SHARE_LINK_MAX_ZOOM, value.zoom)),
      createdAtMs: value.createdAtMs,
      lastAccessAtMs: value.lastAccessAtMs,
      creatorUid,
    };
  } catch {
    return null;
  }
}

function readBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return authHeader.slice("bearer ".length).trim();
}

async function resolveShareCreatorUid(request: Request, env: Env): Promise<string | null> {
  const token = readBearerToken(request);
  if (token.length === 0) {
    return null;
  }

  const claims = await verifyIdentityToken({
    token,
    secret: resolveIdentitySigningSecret(env),
  });
  return claims?.uid ?? null;
}

function extractShareLinkId(pathname: string): string | null {
  if (!pathname.startsWith("/share-links/")) {
    return null;
  }

  const encodedId = pathname.slice("/share-links/".length);
  if (encodedId.length === 0 || encodedId.includes("/")) {
    return null;
  }

  let decodedId = "";
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }

  return SHARE_LINK_UUID_PATTERN.test(decodedId) ? decodedId.toLowerCase() : null;
}

async function handleCreateShareLinkRequest(request: Request, env: Env): Promise<Response> {
  const store = env.SHARE_LINKS;
  if (!store) {
    return withShareLinkCors(
      jsonResponse(
        {
          code: "share_unavailable",
          msg: "Share links are unavailable",
        },
        { status: 503 }
      )
    );
  }

  const body = await readJson<unknown>(request);
  const camera = parseShareLinkCreatePayload(body);
  if (!camera) {
    return withShareLinkCors(
      jsonResponse(
        {
          code: "invalid_payload",
          msg: "Invalid share payload",
        },
        { status: 400 }
      )
    );
  }

  const creatorUid = await resolveShareCreatorUid(request, env);
  const id = crypto.randomUUID().toLowerCase();
  const nowMs = Date.now();
  const record: ShareLinkRecord = {
    x: camera.x,
    y: camera.y,
    zoom: camera.zoom,
    createdAtMs: nowMs,
    lastAccessAtMs: nowMs,
    creatorUid,
  };
  await store.put(shareLinkKey(id), JSON.stringify(record), {
    expirationTtl: SHARE_LINK_TTL_SECONDS,
  });

  return withShareLinkCors(
    jsonResponse({
      id,
      creatorUid,
    })
  );
}

async function handleGetShareLinkRequest(shareId: string, env: Env): Promise<Response> {
  const store = env.SHARE_LINKS;
  if (!store) {
    return withShareLinkCors(
      jsonResponse(
        {
          code: "share_unavailable",
          msg: "Share links are unavailable",
        },
        { status: 503 }
      )
    );
  }

  const record = parseShareLinkRecord(await store.get(shareLinkKey(shareId)));
  if (!record) {
    return withShareLinkCors(
      jsonResponse(
        {
          code: "share_not_found",
          msg: "Share link not found",
        },
        { status: 404 }
      )
    );
  }

  const refreshed: ShareLinkRecord = {
    ...record,
    lastAccessAtMs: Date.now(),
  };
  await store.put(shareLinkKey(shareId), JSON.stringify(refreshed), {
    expirationTtl: SHARE_LINK_TTL_SECONDS,
  });

  return withShareLinkCors(
    jsonResponse({
      x: refreshed.x,
      y: refreshed.y,
      zoom: refreshed.zoom,
      creatorUid: refreshed.creatorUid,
    })
  );
}

async function handleAuthSessionRequest(request: Request, env: Env): Promise<Response> {
  if (resolveAuthMode(env) === "legacy") {
    return withAuthSessionCors(new Response("Not found", { status: 404 }));
  }

  if (!env.ACCOUNT_LINK) {
    return withAuthSessionCors(
      jsonResponse(
        {
          code: "auth_unavailable",
          msg: "Account link service unavailable",
        },
        { status: 503 }
      )
    );
  }

  const body = await readJson<unknown>(request);
  const parsed = parseAuthSessionRequest(body);
  if (!parsed) {
    return withAuthSessionCors(
      jsonResponse(
        {
          code: "invalid_payload",
          msg: "Invalid auth session payload",
        },
        { status: 400 }
      )
    );
  }

  const verifier =
    env.EXTERNAL_IDENTITY_VERIFIER ??
    (() => {
      const projectId = typeof env.FIREBASE_PROJECT_ID === "string" ? env.FIREBASE_PROJECT_ID.trim() : "";
      if (projectId.length === 0) {
        return null;
      }
      return new FirebaseIdTokenVerifier({
        projectId,
      });
    })();

  if (!verifier) {
    console.error("auth_session_verifier_not_configured", {
      hasExternalVerifier: Boolean(env.EXTERNAL_IDENTITY_VERIFIER),
      hasFirebaseProjectId: typeof env.FIREBASE_PROJECT_ID === "string" && env.FIREBASE_PROJECT_ID.trim().length > 0,
    });
    return withAuthSessionCors(
      jsonResponse(
        {
          code: "auth_unavailable",
          msg: "Firebase verifier is not configured",
          detail: "Set FIREBASE_PROJECT_ID on the worker environment",
        },
        { status: 503 }
      )
    );
  }

  const links = new AccountLinkDORepository({
    namespace: env.ACCOUNT_LINK,
  });
  const service = new DefaultAuthSessionService({
    verifier,
    links,
    signingSecret: resolveIdentitySigningSecret(env),
  });

  try {
    const session = await service.createOrResumeSession(parsed);
    return withAuthSessionCors(jsonResponse(session));
  } catch (error) {
    if (error instanceof AuthSessionServiceError) {
      return withAuthSessionCors(
        jsonResponse(
          {
            code: error.code,
            msg: error.message,
          },
          { status: error.status }
        )
      );
    }

    const errorDetail = error instanceof Error ? error.message : String(error);
    console.error("auth_session_unhandled_error", {
      error: errorDetail,
    });
    return withAuthSessionCors(
      jsonResponse(
        {
          code: "auth_unavailable",
          msg: "Unable to create auth session",
          detail: errorDetail,
        },
        { status: 503 }
      )
    );
  }
}

export async function handleWorkerFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      ws: "/ws",
    });
  }

  if (url.pathname === "/cell-last-edit" && request.method === "GET") {
    const tileKey = url.searchParams.get("tile");
    const rawIndex = url.searchParams.get("i");
    if (!tileKey || !isValidTileKey(tileKey) || !rawIndex || !/^\d+$/.test(rawIndex)) {
      return withCellLastEditCors(new Response("Invalid tile or cell index", { status: 400 }));
    }

    const index = Number.parseInt(rawIndex, 10);
    if (!isCellIndexValid(index)) {
      return withCellLastEditCors(new Response("Invalid tile or cell index", { status: 400 }));
    }

    const response = await env.TILE_OWNER.getByName(tileKey).fetch(
      `https://tile-owner.internal/cell-last-edit?tile=${encodeURIComponent(tileKey)}&i=${index}`
    );
    return withCellLastEditCors(response);
  }

  if (url.pathname === "/cell-last-edit" && request.method === "OPTIONS") {
    return cellLastEditCorsPreflightResponse();
  }

  if (url.pathname === "/share-links" && request.method === "POST") {
    return handleCreateShareLinkRequest(request, env);
  }

  if (url.pathname === "/share-links" && request.method === "OPTIONS") {
    return shareLinkCorsPreflightResponse();
  }

  if (url.pathname.startsWith("/share-links/") && request.method === "GET") {
    const shareId = extractShareLinkId(url.pathname);
    if (!shareId) {
      return withShareLinkCors(
        jsonResponse(
          {
            code: "invalid_share_id",
            msg: "Invalid share link id",
          },
          { status: 400 }
        )
      );
    }
    return handleGetShareLinkRequest(shareId, env);
  }

  if (url.pathname.startsWith("/share-links/") && request.method === "OPTIONS") {
    return shareLinkCorsPreflightResponse();
  }

  if (url.pathname === "/auth/session" && request.method === "POST") {
    return handleAuthSessionRequest(request, env);
  }

  if (url.pathname === "/auth/session" && request.method === "OPTIONS") {
    return authSessionCorsPreflightResponse();
  }

  if (url.pathname !== "/ws") {
    return new Response("Not found", { status: 404 });
  }

  if (isWebSocketTemporarilyDisabled(env)) {
    return new Response("WebSocket temporarily disabled", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "3600",
      },
    });
  }

  if (!isWebSocketUpgrade(request)) {
    return new Response("Expected websocket upgrade", { status: 426 });
  }

  const identity = await resolveIdentity(url, env);
  if (!identity) {
    return new Response("Missing valid auth token", { status: 401 });
  }
  const shardName = shardNameForUid(identity.uid);
  const shardUrl = buildShardUrl(identity, shardName);

  const headers = new Headers(request.headers);
  const shardRequest = new Request(shardUrl.toString(), {
    method: "GET",
    headers,
  });

  const shardStub = env.CONNECTION_SHARD.getByName(shardName);
  return shardStub.fetch(shardRequest);
}
