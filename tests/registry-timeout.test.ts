import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("community registry network timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns a bounded error when GitHub never responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    const { fetchRegistry } = await import("../src/main/registry");

    const resultPromise = fetchRegistry(true);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        skills: [],
        mcps: [],
        agents: [],
        workflows: [],
        error: "Community registry request timed out",
      }),
    );
  });
});
