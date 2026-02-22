import { EDIT_MIN_CELL_PX } from "@sea/domain";

import { APP_NAME } from "./appConstants";

function queryRequiredElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required DOM element: ${selector}`);
  }
  return element;
}

export function getRequiredElements() {
  const canvas = queryRequiredElement("#viewport");
  const identityEl = queryRequiredElement("#identity");
  const statusEl = queryRequiredElement("#status");
  const zoomEl = queryRequiredElement("#zoom-readout");
  const titleEl = document.querySelector("#hud h1");
  const interactionOverlayEl = queryRequiredElement("#interaction-overlay");
  const interactionOverlayTextEl = queryRequiredElement("#interaction-overlay-text");
  const offlineBannerEl = queryRequiredElement("#offline-banner");
  const inspectToggleEl = queryRequiredElement("#inspect-mode-toggle");
  const inspectLabelEl = queryRequiredElement("#inspect-mode-label");
  const editInfoPopupEl = queryRequiredElement("#edit-info-popup");

  return {
    canvas,
    identityEl,
    statusEl,
    zoomEl,
    titleEl,
    interactionOverlayEl,
    interactionOverlayTextEl,
    offlineBannerEl,
    inspectToggleEl,
    inspectLabelEl,
    editInfoPopupEl,
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
