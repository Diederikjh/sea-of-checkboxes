import {
  Text,
  TextStyle,
} from "pixi.js";

import { toScreenPoint } from "./coords";

const cursorLabelStyle = new TextStyle({
  fontFamily: "IBM Plex Sans",
  fontSize: 12,
  fill: 0xe5edf7,
  stroke: 0x111820,
  strokeThickness: 3,
});

export function createCursorLabels(stage) {
  const labels = new Map();

  function ensure(uid, name) {
    let label = labels.get(uid);
    if (!label) {
      label = new Text(name, cursorLabelStyle);
      label.anchor.set(0, 1);
      stage.addChild(label);
      labels.set(uid, label);
    }
    label.text = name;
    return label;
  }

  function update(activeCursors, camera, viewportWidth, viewportHeight) {
    const usedLabels = new Set();

    for (const cursor of activeCursors) {
      const label = ensure(cursor.uid, cursor.name);
      const worldX = Number.isFinite(cursor.drawX) ? cursor.drawX : cursor.x;
      const worldY = Number.isFinite(cursor.drawY) ? cursor.drawY : cursor.y;
      const screen = toScreenPoint(worldX, worldY, camera, viewportWidth, viewportHeight);
      label.x = screen.x + 6;
      label.y = screen.y - 6;
      label.visible = true;
      usedLabels.add(cursor.uid);
    }

    for (const [uid, label] of labels) {
      if (!usedLabels.has(uid)) {
        label.visible = false;
      }
    }
  }

  function destroy() {
    for (const label of labels.values()) {
      stage.removeChild(label);
      label.destroy();
    }
    labels.clear();
  }

  return {
    update,
    destroy,
  };
}
