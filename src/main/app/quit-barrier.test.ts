import { describe, expect, it, vi } from "vitest";
import { createQuitBarrier } from "./quit-barrier";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createQuitBarrier", () => {
  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Awaited Electron quit barrier]]
  it("waits for one cleanup before allowing Electron to quit", async () => {
    const cleanupDeferred = deferred();
    const cleanup = vi.fn(() => cleanupDeferred.promise);
    const quit = vi.fn();
    const onError = vi.fn();
    const handler = createQuitBarrier(cleanup, quit, onError);
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };
    const finalEvent = { preventDefault: vi.fn() };

    handler(firstEvent);
    handler(secondEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    cleanupDeferred.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    handler(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
