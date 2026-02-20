import {
  cellIndexFromWorld,
  tileKeyFromWorld,
} from "@sea/domain";

import { canEditAtZoom, zoomCamera } from "./camera";
import { toWorldCell } from "./coords";
import { updateZoomReadout } from "./dom";
import { logger } from "./logger";

function createOpId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
}

function buildWorldPointerContext(event, world) {
  return {
    screenX: event.clientX,
    screenY: event.clientY,
    worldX: world.x,
    worldY: world.y,
    boardX: world.x + 0.5,
    boardY: world.y + 0.5,
  };
}

function formatEditTimestamp(atMs) {
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) {
    return "time unknown";
  }
  return date.toLocaleString();
}

function showEditInfoPopup(editInfoPopupEl, clientX, clientY, text) {
  editInfoPopupEl.textContent = text;
  editInfoPopupEl.hidden = false;
  editInfoPopupEl.style.left = `${clientX + 12}px`;
  editInfoPopupEl.style.top = `${clientY + 12}px`;

  const rect = editInfoPopupEl.getBoundingClientRect();
  const clampedLeft = Math.min(
    Math.max(8, clientX + 12),
    Math.max(8, window.innerWidth - rect.width - 8)
  );
  const clampedTop = Math.min(
    Math.max(8, clientY + 12),
    Math.max(8, window.innerHeight - rect.height - 8)
  );
  editInfoPopupEl.style.left = `${clampedLeft}px`;
  editInfoPopupEl.style.top = `${clampedTop}px`;
}

function hideEditInfoPopup(editInfoPopupEl) {
  editInfoPopupEl.hidden = true;
}

async function fetchCellLastEditInfo(fetchImpl, apiBaseUrl, tileKey, cellIndex) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch unavailable");
  }

  const response = await fetchImpl(
    `${apiBaseUrl}/cell-last-edit?tile=${encodeURIComponent(tileKey)}&i=${cellIndex}`
  );
  if (!response.ok) {
    throw new Error(`unexpected_status_${response.status}`);
  }

  return response.json();
}

export function setupInputHandlers({
  canvas,
  camera,
  getViewportSize,
  zoomEl,
  transport,
  tileStore,
  heatStore,
  setStatus,
  inspectToggleEl,
  inspectLabelEl,
  editInfoPopupEl,
  apiBaseUrl,
  fetchImpl = typeof fetch === "function" ? fetch.bind(globalThis) : undefined,
  onViewportChanged,
  onTileCellsChanged = () => {},
}) {
  let dragging = false;
  let dragStart = null;
  let lastCursorSent = 0;
  let inspectModeEnabled = false;

  const setInspectMode = (enabled) => {
    inspectModeEnabled = enabled;
    inspectToggleEl.setAttribute("aria-pressed", enabled ? "true" : "false");
    inspectLabelEl.textContent = enabled ? "Inspect mode on" : "Inspect mode off";
    canvas.style.cursor = enabled ? "help" : "default";
    if (!enabled) {
      hideEditInfoPopup(editInfoPopupEl);
    }
  };

  setInspectMode(false);

  const onContextMenu = (event) => {
    event.preventDefault();
  };

  const onInspectToggleClick = () => {
    const next = !inspectModeEnabled;
    setInspectMode(next);
    setStatus(next ? "Inspect mode: click a checkbox to see last edit" : "Inspect mode off");
  };

  const onWheel = (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    zoomCamera(camera, factor);
    updateZoomReadout(camera, zoomEl);
    onViewportChanged();
  };

  const onPointerDown = (event) => {
    hideEditInfoPopup(editInfoPopupEl);
    dragging = true;
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };

  const onPointerMove = (event) => {
    if (dragging && dragStart) {
      const deltaX = event.clientX - dragStart.x;
      const deltaY = event.clientY - dragStart.y;
      const moved = Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2;
      dragStart.moved = dragStart.moved || moved;

      camera.x -= event.movementX / camera.cellPixelSize;
      camera.y -= event.movementY / camera.cellPixelSize;
      onViewportChanged();
    }

    const now = performance.now();
    if (now - lastCursorSent <= 80) {
      return;
    }

    lastCursorSent = now;
    const { width, height } = getViewportSize();
    const world = toWorldCell(event.clientX, event.clientY, camera, width, height);
    const payload = { t: "cur", x: world.x + 0.5, y: world.y + 0.5 };
    logger.ui("cursor_emit", buildWorldPointerContext(event, world));
    transport.send(payload);
  };

  const onPointerUp = (event) => {
    const clickLike = dragging && dragStart && !dragStart.moved;
    dragging = false;

    if (!clickLike) {
      dragStart = null;
      return;
    }

    const { width, height } = getViewportSize();
    const world = toWorldCell(event.clientX, event.clientY, camera, width, height);
    const tileKey = tileKeyFromWorld(world.x, world.y);
    const cellIndex = cellIndexFromWorld(world.x, world.y);

    if (inspectModeEnabled) {
      logger.ui("click_inspect", {
        ...buildWorldPointerContext(event, world),
        tile: tileKey,
        i: cellIndex,
      });

      void fetchCellLastEditInfo(fetchImpl, apiBaseUrl, tileKey, cellIndex)
        .then((payload) => {
          const edit = payload?.edit;
          if (!edit) {
            showEditInfoPopup(editInfoPopupEl, event.clientX, event.clientY, "no edits for this box");
            setStatus("no edits for this box");
            return;
          }

          showEditInfoPopup(
            editInfoPopupEl,
            event.clientX,
            event.clientY,
            `${edit.name} (${edit.uid})\n${formatEditTimestamp(edit.atMs)}`
          );
          setStatus(`Last edit by ${edit.name}`);
        })
        .catch(() => {
          setStatus("Could not load edit info");
          showEditInfoPopup(editInfoPopupEl, event.clientX, event.clientY, "Could not load edit info");
        });

      dragStart = null;
      return;
    }

    if (!canEditAtZoom(camera)) {
      logger.ui("click_blocked", {
        reason: "zoom",
        screenX: event.clientX,
        screenY: event.clientY,
      });
      setStatus("Zoom in to edit");
      dragStart = null;
      return;
    }

    const nowMs = Date.now();

    if (heatStore.isLocallyDisabled(tileKey, cellIndex, nowMs)) {
      logger.ui("click_blocked", {
        reason: "cooldown",
        tile: tileKey,
        i: cellIndex,
        ...buildWorldPointerContext(event, world),
      });
      setStatus("Cell is cooling down locally; try again in a moment");
      dragStart = null;
      return;
    }

    const tileData = tileStore.get(tileKey);
    const currentValue = tileData ? tileData.bits[cellIndex] : 0;
    const nextValue = currentValue === 1 ? 0 : 1;

    const payload = {
      t: "setCell",
      tile: tileKey,
      i: cellIndex,
      v: nextValue,
      op: createOpId(),
    };

    const optimisticResult = tileStore.applyOptimistic(tileKey, cellIndex, nextValue);
    if (optimisticResult.applied) {
      onTileCellsChanged(tileKey, [cellIndex]);
    }

    logger.ui("click_setCell", {
      ...buildWorldPointerContext(event, world),
      tile: tileKey,
      i: cellIndex,
      currentValue,
      nextValue,
    });
    transport.send(payload);

    dragStart = null;
  };

  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  inspectToggleEl.addEventListener("click", onInspectToggleClick);

  return () => {
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    inspectToggleEl.removeEventListener("click", onInspectToggleClick);
    canvas.style.cursor = "default";
  };
}
