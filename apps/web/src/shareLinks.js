import {
  SHARE_LINK_URL_PARAM,
  normalizeShareLinkCameraPayload,
  normalizeShareLinkId,
} from "@sea/protocol";

function normalizeSharedCameraPayload(payload) {
  const camera = normalizeShareLinkCameraPayload(payload);
  if (!camera || !payload || typeof payload !== "object") {
    return null;
  }

  return {
    x: camera.x,
    y: camera.y,
    cellPixelSize: camera.zoom,
    creatorUid:
      typeof payload.creatorUid === "string" && payload.creatorUid.trim().length > 0
        ? payload.creatorUid.trim()
        : null,
  };
}

export function readShareIdFromLocation(locationLike = globalThis.window?.location) {
  if (!locationLike || typeof locationLike.href !== "string") {
    return null;
  }

  let url;
  try {
    url = new URL(locationLike.href);
  } catch {
    return null;
  }

  return normalizeShareLinkId(url.searchParams.get(SHARE_LINK_URL_PARAM));
}

export function buildShareUrl(shareId, locationLike = globalThis.window?.location) {
  const normalized = normalizeShareLinkId(shareId);
  if (!normalized || !locationLike || typeof locationLike.href !== "string") {
    return null;
  }

  let url;
  try {
    url = new URL(locationLike.href);
  } catch {
    return null;
  }

  url.search = "";
  url.hash = "";
  url.searchParams.set(SHARE_LINK_URL_PARAM, normalized);
  return url.toString();
}

export async function resolveSharedCamera({
  apiBaseUrl,
  shareId,
  fetchFn = globalThis.fetch,
}) {
  const normalizedId = normalizeShareLinkId(shareId);
  if (!normalizedId) {
    return null;
  }
  if (typeof fetchFn !== "function") {
    throw new Error("share_link_fetch_unavailable");
  }

  const response = await fetchFn(
    `${apiBaseUrl}/share-links/${encodeURIComponent(normalizedId)}`,
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    return null;
  }

  return normalizeSharedCameraPayload(await response.json());
}

export async function createShareLink({
  apiBaseUrl,
  camera,
  identityToken = "",
  locationLike = globalThis.window?.location,
  clipboard = globalThis.navigator?.clipboard,
  fetchFn = globalThis.fetch,
}) {
  if (typeof fetchFn !== "function") {
    throw new Error("share_link_fetch_unavailable");
  }
  const headers = {
    "content-type": "application/json",
  };
  if (typeof identityToken === "string" && identityToken.trim().length > 0) {
    headers.authorization = `Bearer ${identityToken.trim()}`;
  }

  const response = await fetchFn(`${apiBaseUrl}/share-links`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      x: camera.x,
      y: camera.y,
      zoom: camera.cellPixelSize,
    }),
  });
  if (!response.ok) {
    throw new Error(`share_link_create_failed_${response.status}`);
  }

  const data = await response.json();
  const shareId = normalizeShareLinkId(data?.id);
  if (!shareId) {
    throw new Error("share_link_invalid_id");
  }

  const url = buildShareUrl(shareId, locationLike);
  if (!url) {
    throw new Error("share_link_url_build_failed");
  }

  let copied = false;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(url);
      copied = true;
    } catch {
      copied = false;
    }
  }

  return {
    id: shareId,
    url,
    copied,
    creatorUid:
      typeof data?.creatorUid === "string" && data.creatorUid.trim().length > 0
        ? data.creatorUid.trim()
        : null,
  };
}
