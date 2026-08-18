import { describe, expect, it, vi } from "vitest";

import { RuntimeActivityCoordinator } from "../src/main/runtime-activity";

describe("Runtime activity coordination", () => {
  it("reserves a starting run before its abort handle exists", () => {
    const activity = new RuntimeActivityCoordinator();
    const run = activity.beginRun("run-1");

    expect(run).not.toBeNull();
    expect(activity.activeRunCount).toBe(1);
    expect(activity.beginTransition()).toBe(false);

    const abort = vi.fn();
    activity.abortRun("run-1");
    expect(abort).not.toHaveBeenCalled();

    run!.attachAbort(abort);
    expect(abort).toHaveBeenCalledOnce();
    expect(activity.activeRunCount).toBe(1);

    run!.finish();
    expect(activity.activeRunCount).toBe(0);
  });

  it("does not let a stale completion remove a replacement run", () => {
    const activity = new RuntimeActivityCoordinator();
    const firstAbort = vi.fn();
    const first = activity.beginRun("same-run");
    first!.attachAbort(firstAbort);

    const second = activity.beginRun("same-run");

    expect(firstAbort).toHaveBeenCalledOnce();
    expect(activity.activeRunCount).toBe(2);
    expect(activity.beginTransition()).toBe(false);
    first!.finish();
    expect(activity.activeRunCount).toBe(1);

    second!.finish();
    expect(activity.activeRunCount).toBe(0);
  });

  it("atomically blocks new runs while a Runtime transition is reserved", () => {
    const activity = new RuntimeActivityCoordinator();

    expect(activity.beginTransition()).toBe(true);
    expect(activity.beginRun("too-late")).toBeNull();

    activity.cancelTransition();
    const run = activity.beginRun("after-cancel");
    expect(run).not.toBeNull();
    run!.finish();
  });

  it("keeps aborted runs active until every lease actually finishes", () => {
    const activity = new RuntimeActivityCoordinator();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    const first = activity.beginRun("run-1")!;
    const second = activity.beginRun("run-2")!;
    first.attachAbort(firstAbort);
    second.attachAbort(secondAbort);

    activity.abortAll();

    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(activity.activeRunCount).toBe(2);
    expect(activity.beginTransition()).toBe(false);

    first.finish();
    expect(activity.activeRunCount).toBe(1);
    second.finish();
    expect(activity.activeRunCount).toBe(0);
    expect(activity.beginTransition()).toBe(true);
  });

  it("waits for aborted Runtime runs to finish before declaring the context drained", async () => {
    const activity = new RuntimeActivityCoordinator();
    const run = activity.beginRun("run-drain")!;
    activity.abortAll();
    let settled = false;
    const waiting = activity.waitForIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    run.finish();
    await waiting;
    expect(settled).toBe(true);
  });
});
