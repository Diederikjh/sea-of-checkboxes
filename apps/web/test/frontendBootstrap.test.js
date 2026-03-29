import { describe, expect, it, vi } from "vitest";

import { bootstrapFrontend, APP_DISABLED_TEXT } from "../src/frontendBootstrap";
import { startApp } from "../src/app";

vi.mock("../src/app", () => ({
  startApp: vi.fn(),
}));

describe("frontend bootstrap", () => {
  it("renders the unavailable screen and does not load the app runtime when disabled", async () => {
    const appRoot = { textContent: "" };
    const bodyClassList = { add: vi.fn() };
    const documentRef = {
      getElementById: vi.fn(() => appRoot),
      body: {
        classList: bodyClassList,
        textContent: "",
      },
    };

    const teardown = await bootstrapFrontend({
      env: {
        VITE_APP_DISABLED: "1",
      },
      documentRef,
    });

    expect(appRoot.textContent).toBe(APP_DISABLED_TEXT);
    expect(bodyClassList.add).toHaveBeenCalledWith("app-disabled");
    expect(startApp).not.toHaveBeenCalled();
    expect(typeof teardown).toBe("function");
  });
});
