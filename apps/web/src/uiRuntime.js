export function createUiRuntime({
  statusEl,
  interactionOverlayEl,
  interactionOverlayTextEl,
  setTimeoutFn,
  clearTimeoutFn,
  interactionDismissMs = 3_000,
}) {
  let interactionTimerId = null;

  const clearInteractionTimer = () => {
    if (interactionTimerId !== null) {
      clearTimeoutFn(interactionTimerId);
      interactionTimerId = null;
    }
  };

  const setStatus = (value) => {
    statusEl.textContent = value;
  };

  const setInteractionRestriction = (state, message) => {
    interactionOverlayEl.dataset.state = state;
    interactionOverlayTextEl.textContent = message;
    interactionOverlayEl.hidden = false;

    clearInteractionTimer();
    interactionTimerId = setTimeoutFn(() => {
      interactionOverlayEl.hidden = true;
      delete interactionOverlayEl.dataset.state;
      interactionOverlayTextEl.textContent = "";
      interactionTimerId = null;
    }, interactionDismissMs);
  };

  return {
    setStatus,
    setInteractionRestriction,
    dispose() {
      clearInteractionTimer();
    },
  };
}
