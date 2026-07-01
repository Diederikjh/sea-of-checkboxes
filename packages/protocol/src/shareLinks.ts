import {
  MIN_CELL_PX,
  clampCameraCenter,
  isFiniteNumber,
} from "@sea/domain";

export const SHARE_LINK_URL_PARAM = "share";
export const SHARE_LINK_MAX_ZOOM = 64;
export const SHARE_LINK_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ShareLinkCameraPayload {
  x: number;
  y: number;
  zoom: number;
}

export function normalizeShareLinkId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return SHARE_LINK_UUID_PATTERN.test(trimmed) ? trimmed : null;
}

export function clampShareLinkZoom(zoom: number): number {
  return Math.max(MIN_CELL_PX, Math.min(SHARE_LINK_MAX_ZOOM, zoom));
}

export function normalizeShareLinkCameraPayload(value: unknown): ShareLinkCameraPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as { x?: unknown; y?: unknown; zoom?: unknown };
  if (!isFiniteNumber(payload.x) || !isFiniteNumber(payload.y) || !isFiniteNumber(payload.zoom)) {
    return null;
  }

  const clampedCenter = clampCameraCenter(payload.x, payload.y);
  return {
    x: clampedCenter.x,
    y: clampedCenter.y,
    zoom: clampShareLinkZoom(payload.zoom),
  };
}
