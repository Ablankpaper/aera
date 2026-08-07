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

    inFlight = cleanup()
      .catch(onError)
      .then(() => {
        complete = true;
        quit();
      });
  };
}
