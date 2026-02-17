export async function waitFor(
  assertion: () => void,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 5;

  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
