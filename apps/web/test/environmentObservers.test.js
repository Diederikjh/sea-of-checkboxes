import { describe, expect, it, vi } from "vitest";

import { createEnvironmentObservers } from "../src/environmentObservers";

describe("environmentObservers", () => {
  it("registers and removes all window listeners", () => {
    const windowObj = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const documentObj = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const callbacks = {
      onResize: vi.fn(),
      onFocus: vi.fn(),
      onPageShow: vi.fn(),
      onOffline: vi.fn(),
      onOnline: vi.fn(),
      onVisibilityChange: vi.fn(),
    };

    const observers = createEnvironmentObservers({
      windowObj,
      documentObj,
      ...callbacks,
    });

    expect(windowObj.addEventListener).toHaveBeenCalledWith("resize", callbacks.onResize);
    expect(windowObj.addEventListener).toHaveBeenCalledWith("focus", callbacks.onFocus);
    expect(windowObj.addEventListener).toHaveBeenCalledWith("pageshow", callbacks.onPageShow);
    expect(windowObj.addEventListener).toHaveBeenCalledWith("offline", callbacks.onOffline);
    expect(windowObj.addEventListener).toHaveBeenCalledWith("online", callbacks.onOnline);
    expect(documentObj.addEventListener).toHaveBeenCalledWith("visibilitychange", callbacks.onVisibilityChange);

    observers.dispose();

    expect(windowObj.removeEventListener).toHaveBeenCalledWith("resize", callbacks.onResize);
    expect(windowObj.removeEventListener).toHaveBeenCalledWith("focus", callbacks.onFocus);
    expect(windowObj.removeEventListener).toHaveBeenCalledWith("pageshow", callbacks.onPageShow);
    expect(windowObj.removeEventListener).toHaveBeenCalledWith("offline", callbacks.onOffline);
    expect(windowObj.removeEventListener).toHaveBeenCalledWith("online", callbacks.onOnline);
    expect(documentObj.removeEventListener).toHaveBeenCalledWith("visibilitychange", callbacks.onVisibilityChange);
  });
});
