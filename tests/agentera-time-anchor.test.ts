// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AgenteraTrustedTimeAnchor } from "../src/main/agentera-auth/time-anchor";

describe("AgentEra trusted time anchor", () => {
  it("advances with monotonic time even when the wall clock stalls", () => {
    const wall = Date.parse("2026-07-18T01:00:00.000Z");
    let monotonic = 10_000;
    const anchor = new AgenteraTrustedTimeAnchor({
      trustedServerTime: "2026-07-18T01:00:00.000Z",
      wallNow: () => wall,
      monotonicNow: () => monotonic,
    });

    monotonic += 60 * 60 * 1000;
    const result = anchor.evaluate();

    expect(result.rollbackDetected).toBe(false);
    expect(result.trustedNow.toISOString()).toBe("2026-07-18T02:00:00.000Z");
  });

  it("detects startup and in-process wall-clock rollback beyond tolerance", () => {
    let wall = Date.parse("2026-07-18T00:50:00.000Z");
    let monotonic = 5_000;
    const startup = new AgenteraTrustedTimeAnchor({
      trustedServerTime: "2026-07-18T01:00:00.000Z",
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      rollbackToleranceMs: 2 * 60 * 1000,
    });
    expect(startup.evaluate().rollbackDetected).toBe(true);

    wall = Date.parse("2026-07-18T01:00:00.000Z");
    monotonic = 10_000;
    const running = new AgenteraTrustedTimeAnchor({
      trustedServerTime: "2026-07-18T01:00:00.000Z",
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      rollbackToleranceMs: 2 * 60 * 1000,
    });
    wall -= 30 * 60 * 1000;
    monotonic += 60 * 60 * 1000;
    expect(running.evaluate().rollbackDetected).toBe(true);
  });

  it("accepts small clock skew and resets only from a trusted server value", () => {
    let wall = Date.parse("2026-07-18T00:59:30.000Z");
    let monotonic = 1_000;
    const anchor = new AgenteraTrustedTimeAnchor({
      trustedServerTime: "2026-07-18T01:00:00.000Z",
      wallNow: () => wall,
      monotonicNow: () => monotonic,
    });
    expect(anchor.evaluate().rollbackDetected).toBe(false);

    wall = Date.parse("2026-07-19T02:00:00.000Z");
    monotonic += 1_000;
    anchor.reset("2026-07-19T02:00:00.000Z");
    expect(anchor.evaluate()).toMatchObject({ rollbackDetected: false });
    expect(() => anchor.reset("not-a-date")).toThrow(/trusted server time/i);
  });
});
