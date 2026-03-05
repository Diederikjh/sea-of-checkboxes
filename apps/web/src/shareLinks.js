import {
  MIN_CELL_PX,
  clampCameraCenter,
} from "@sea/domain";

const SHARE_PARAM = "share";
const SHARE_MAX_ZOOM = 64;
const SHARE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeShareId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return SHARE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeSharedCameraPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const { x, y, zoom } = payload;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) {
    return null;
  }

  const clampedCenter = clampCameraCenter(x, y);
  return {
    x: clampedCenter.x,
    y: clampedCenter.y,
    cellPixelSize: Math.max(MIN_CELL_PX, Math.min(SHARE_MAX_ZOOM, zoom)),
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

  return normalizeShareId(url.searchParams.get(SHARE_PARAM));
}

export function buildShareUrl(shareId, locationLike = globalThis.window?.location) {
  const normalized = normalizeShareId(shareId);
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
  url.searchParams.set(SHARE_PARAM, normalized);
  return url.toString();
}

export async function resolveSharedCamera({
  apiBaseUrl,
  shareId,
  fetchFn = globalThis.fetch,
}) {
  const normalizedId = normalizeShareId(shareId);
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
  locationLike = globalThis.window?.location,
  clipboard = globalThis.navigator?.clipboard,
  fetchFn = globalThis.fetch,
}) {
  if (typeof fetchFn !== "function") {
    throw new Error("share_link_fetch_unavailable");
  }
  const response = await fetchFn(`${apiBaseUrl}/share-links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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
  const shareId = normalizeShareId(data?.id);
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
  };
}
