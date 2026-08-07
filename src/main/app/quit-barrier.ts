export interface QuitBarrierEvent {
  preventDefault(): void;
}

export function createQuitBarrier(
  cleanup: () => Promise<void>,
  quit: () => void,
  onError: (error: unknown) => void,
): (event: QuitBarrierEvent) => void {
  let complete = false;
  let inFlight: Promise<void> | null = null;

  return (event) => {
    if (complete) return;
    event.preventDefault();
    if (inFlight) return;

    const fail = (error: unknown): void => {
      try {
        onError(error);
      } finally {
        // Cleanup failures keep Electron open. A later explicit quit request
        // may retry the same bounded ownership cleanup.
        inFlight = null;
      }
    };
    try {
      inFlight = Promise.resolve(cleanup()).then(() => {
        complete = true;
        quit();
      }, fail);
    } catch (error) {
      fail(error);
    }
  };
}
