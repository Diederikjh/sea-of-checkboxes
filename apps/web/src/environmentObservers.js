export function createEnvironmentObservers({
  windowObj,
  documentObj,
  onResize,
  onFocus,
  onPageShow,
  onOffline,
  onOnline,
  onVisibilityChange,
}) {
  windowObj.addEventListener("resize", onResize);
  windowObj.addEventListener("focus", onFocus);
  windowObj.addEventListener("pageshow", onPageShow);
  windowObj.addEventListener("offline", onOffline);
  windowObj.addEventListener("online", onOnline);

  const hasDocumentEvents = typeof documentObj?.addEventListener === "function";
  if (hasDocumentEvents) {
    documentObj.addEventListener("visibilitychange", onVisibilityChange);
  }

  return {
    dispose() {
      windowObj.removeEventListener("resize", onResize);
      windowObj.removeEventListener("focus", onFocus);
      windowObj.removeEventListener("pageshow", onPageShow);
      windowObj.removeEventListener("offline", onOffline);
      windowObj.removeEventListener("online", onOnline);
      if (typeof documentObj?.removeEventListener === "function") {
        documentObj.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
  };
}
