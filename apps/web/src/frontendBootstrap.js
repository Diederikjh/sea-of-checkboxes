import { resolveFrontendRuntimeFlags } from "./runtimeFlags";

const APP_DISABLED_TEXT = "Sea of checkboxes is unavailable for now";

function getAppRoot(documentRef) {
  if (!documentRef) {
    return null;
  }

  if (typeof documentRef.getElementById === "function") {
    return documentRef.getElementById("app");
  }

  if (typeof documentRef.querySelector === "function") {
    return documentRef.querySelector("#app");
  }

  return null;
}

function renderUnavailableScreen(documentRef) {
  const appRoot = getAppRoot(documentRef);
  if (appRoot && "textContent" in appRoot) {
    appRoot.textContent = APP_DISABLED_TEXT;
  } else if (documentRef?.body && "textContent" in documentRef.body) {
    documentRef.body.textContent = APP_DISABLED_TEXT;
  }

  if (documentRef?.body?.classList?.add) {
    documentRef.body.classList.add("app-disabled");
  }
}

export async function bootstrapFrontend({
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  documentRef = typeof document !== "undefined" ? document : null,
  runtimeFlags = resolveFrontendRuntimeFlags(env),
} = {}) {
  if (runtimeFlags.appDisabled) {
    renderUnavailableScreen(documentRef);
    return () => {};
  }

  const { startApp } = await import("./app");
  return startApp({
    runtimeFlags,
  });
}

export { APP_DISABLED_TEXT, renderUnavailableScreen };

