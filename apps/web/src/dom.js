import { EDIT_MIN_CELL_PX } from "@sea/domain";

import { APP_NAME } from "./appConstants";

export function getRequiredElements() {
  const canvas = document.querySelector("#viewport");
  const identityEl = document.querySelector("#identity");
  const statusEl = document.querySelector("#status");
  const zoomEl = document.querySelector("#zoom-readout");
  const titleEl = document.querySelector("#hud h1");

  if (!canvas || !identityEl || !statusEl || !zoomEl) {
    throw new Error("Missing required DOM elements");
  }

  return {
    canvas,
    identityEl,
    statusEl,
    zoomEl,
    titleEl,
  };
}

export function applyBranding(titleEl) {
  document.title = APP_NAME;
  if (titleEl) {
    titleEl.textContent = APP_NAME;
  }
}

export function updateZoomReadout(camera, zoomEl) {
  const mode = camera.cellPixelSize >= EDIT_MIN_CELL_PX ? "edit enabled" : "8-bit mode (read-only)";
  zoomEl.textContent = `Zoom: ${camera.cellPixelSize.toFixed(1)} px/cell, ${mode}`;
}
