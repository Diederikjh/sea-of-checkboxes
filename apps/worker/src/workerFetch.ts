import { isCellIndexValid } from "@sea/domain";

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

function buildShardUrl(identity: ConnectionIdentity, shardName: string): URL {
  const shardUrl = new URL("https://connection-shard.internal/ws");
  shardUrl.searchParams.set("uid", identity.uid);
  shardUrl.searchParams.set("name", identity.name);
  shardUrl.searchParams.set("token", identity.token);
  shardUrl.searchParams.set("shard", shardName);
  return shardUrl;
}

async function resolveIdentity(url: URL, env: Env): Promise<ConnectionIdentity | null> {
  const requestedToken = url.searchParams.get("token")?.trim() ?? "";
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
    return withAuthSessionCors(
      jsonResponse(
        {
          code: "auth_unavailable",
          msg: "Firebase verifier is not configured",
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

    return withAuthSessionCors(
      jsonResponse(
        {
          code: "auth_unavailable",
          msg: "Unable to create auth session",
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

  if (url.pathname === "/auth/session" && request.method === "POST") {
    return handleAuthSessionRequest(request, env);
  }

  if (url.pathname === "/auth/session" && request.method === "OPTIONS") {
    return authSessionCorsPreflightResponse();
  }

  if (url.pathname !== "/ws") {
    return new Response("Not found", { status: 404 });
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
