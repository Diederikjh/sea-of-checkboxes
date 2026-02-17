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

export function setupInputHandlers({
  canvas,
  camera,
  getViewportSize,
  zoomEl,
  transport,
  tileStore,
  heatStore,
  setStatus,
  onViewportChanged,
}) {
  let dragging = false;
  let dragStart = null;
  let lastCursorSent = 0;

  const onContextMenu = (event) => {
    event.preventDefault();
  };

  const onWheel = (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    zoomCamera(camera, factor);
    updateZoomReadout(camera, zoomEl);
    onViewportChanged();
  };

  const onPointerDown = (event) => {
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

    const { width, height } = getViewportSize();
    const world = toWorldCell(event.clientX, event.clientY, camera, width, height);
    const tileKey = tileKeyFromWorld(world.x, world.y);
    const cellIndex = cellIndexFromWorld(world.x, world.y);
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

  return () => {
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
  };
}
