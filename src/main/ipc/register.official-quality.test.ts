// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { LocalRuntimeBinding } from "../agentera-agent-control/runtime-binding-store";
import { createOfficialQualityChatObserver } from "../agentera-official-quality/collector";

const binding = {
  id: "90000000-0000-4000-8000-000000000001",
  officialReleaseRevisionId: "70000000-0000-4000-8000-000000000001",
} as LocalRuntimeBinding;

describe("register IPC official quality terminal bridge", () => {
  it("retains only bounded total tokens and never gives response or raw error strings to the manager", () => {
    const recordMetric = vi.fn();
    const observer = createOfficialQualityChatObserver({
      binding,
      startedAt: 1_000,
      now: () => 7_000,
      recordMetric,
    });
    observer.onUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 999,
      privateResponse: "response-private-canary",
    });
    observer.onDone();

    expect(recordMetric).toHaveBeenCalledWith({
      binding,
      startedAt: 1_000,
      endedAt: 7_000,
      totalTokens: 150,
      result: "success",
      crashCode: null,
    });
    expect(JSON.stringify(recordMetric.mock.calls)).not.toContain(
      "response-private-canary",
    );

    recordMetric.mockClear();
    const failed = createOfficialQualityChatObserver({
      binding,
      startedAt: 1_000,
      now: () => 2_000,
      recordMetric,
    });
    failed.onUsage({ totalTokens: 20 });
    failed.onError(
      "AgentEra Runtime process exited. raw-error-private-canary /Users/private",
    );
    expect(recordMetric).toHaveBeenCalledWith({
      binding,
      startedAt: 1_000,
      endedAt: 2_000,
      totalTokens: 20,
      result: "runtime_crash",
      crashCode: "runtime_process_exit",
    });
    expect(JSON.stringify(recordMetric.mock.calls)).not.toContain(
      "raw-error-private-canary",
    );
    expect(JSON.stringify(recordMetric.mock.calls)).not.toContain(
      "/Users/private",
    );
  });

  it("records at most one terminal event and ignores malformed usage", () => {
    const recordMetric = vi.fn();
    const observer = createOfficialQualityChatObserver({
      binding,
      startedAt: 1_000,
      now: () => 2_000,
      recordMetric,
    });
    observer.onUsage({ totalTokens: "20" });
    observer.onDone();
    observer.onError("later error");
    expect(recordMetric).toHaveBeenCalledTimes(1);
    expect(recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: null, result: "success" }),
    );
  });
});
