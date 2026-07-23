// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RuntimeActivityCoordinator } from "./runtime-activity";

describe("RuntimeActivityCoordinator snapshot gate", () => {
  it("rejects a snapshot while a foreground run is active", () => {
    const activity = new RuntimeActivityCoordinator();
    const run = activity.beginRun("run-1");
    expect(run).not.toBeNull();
    expect(activity.beginSnapshot()).toBeNull();
    run?.finish();
    const snapshot = activity.beginSnapshot();
    expect(snapshot).not.toBeNull();
    snapshot?.finish();
  });

  it("blocks new runs and transitions while a snapshot lease is held", () => {
    const activity = new RuntimeActivityCoordinator();
    const snapshot = activity.beginSnapshot();
    expect(snapshot).not.toBeNull();
    expect(activity.snapshotActive).toBe(true);
    expect(activity.beginRun("run-too-late")).toBeNull();
    expect(activity.beginTransition()).toBe(false);
    expect(activity.beginSnapshot()).toBeNull();
    snapshot?.finish();
    snapshot?.finish();
    expect(activity.snapshotActive).toBe(false);
    expect(activity.beginRun("run-after")).not.toBeNull();
  });

  it("always releases the gate after success, error, or cancellation", async () => {
    const activity = new RuntimeActivityCoordinator();
    await expect(activity.withSnapshot(async () => "complete")).resolves.toBe(
      "complete",
    );
    expect(activity.snapshotActive).toBe(false);

    await expect(
      activity.withSnapshot(async () => {
        throw new Error("snapshot failed");
      }),
    ).rejects.toThrow("snapshot failed");
    expect(activity.snapshotActive).toBe(false);

    const controller = new AbortController();
    controller.abort();
    await expect(
      activity.withSnapshot(async () => {
        if (controller.signal.aborted) throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(activity.snapshotActive).toBe(false);
    expect(activity.beginRun("run-after-all-paths")).not.toBeNull();
  });
});
