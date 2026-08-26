import { describe, expect, it, vi } from "vitest";
import { settleRuntimeCleanup } from "./runtime-cleanup";

describe("settleRuntimeCleanup", () => {
  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Awaited Electron quit barrier]]
  it("attempts every cleanup when one branch rejects", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = vi.fn(async () => {
      throw new Error("dashboard cleanup failed");
    });
    const second = vi.fn(() => pending);
    const third = vi.fn(async () => undefined);

    const cleanup = settleRuntimeCleanup([first, second, third]);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
    });

    release();
    await expect(cleanup).rejects.toThrow("Aera Runtime cleanup failed");
  });
});
