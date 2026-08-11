import { describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  dashboardStatus: vi.fn(),
  legacyGatewayHealthy: vi.fn(),
}));

vi.mock("../dashboard", () => ({
  getDashboardStatus: gatewayMocks.dashboardStatus,
}));
vi.mock("../hermes", () => ({
  isGatewayHealthy: gatewayMocks.legacyGatewayHealthy,
}));
vi.mock("../utils", () => ({
  getActiveProfileNameSync: () => "default",
}));

import {
  createDefaultDesktopHealthDependencies,
  runDesktopControlHealthProbe,
} from "./health";

describe("Desktop control health probe", () => {
  it("accepts the active Dashboard Gateway without requiring the legacy API Gateway", async () => {
    gatewayMocks.dashboardStatus.mockResolvedValue({
      supported: true,
      running: true,
    });
    gatewayMocks.legacyGatewayHealthy.mockResolvedValue(false);

    const dependencies = createDefaultDesktopHealthDependencies();

    await expect(dependencies.isGatewayHealthy()).resolves.toBe(true);
    expect(gatewayMocks.legacyGatewayHealthy).not.toHaveBeenCalled();
  });

  // @lat: [[lat.md/agentera-desktop-control#Fixed health check]]
  it("returns runtime unavailable without running the gateway probe", async () => {
    const gateway = vi.fn(async () => true);
    const result = await runDesktopControlHealthProbe({
      getRuntimeInvocation: () => null,
      isGatewayHealthy: gateway,
      runConfigHealthCheck: () => ({
        ranAt: 0,
        profile: "/private/profile",
        issues: [],
        summary: { errors: 0, warnings: 0, infos: 0 },
      }),
      now: sequenceClock(100, 112),
    });
    expect(result).toEqual({
      state: "failed",
      code: "RUNTIME_UNAVAILABLE",
      summary: {
        desktop_status: "healthy",
        runtime_status: "unhealthy",
        gateway_status: "unknown",
        code: "RUNTIME_UNAVAILABLE",
        duration_ms: 12,
      },
    });
    expect(gateway).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/private/profile");
  });

  it("maps a healthy fixed probe to a content-free summary", async () => {
    const result = await runDesktopControlHealthProbe({
      getRuntimeInvocation: () => ({ available: true }),
      isGatewayHealthy: async () => true,
      runConfigHealthCheck: () => ({
        ranAt: 0,
        profile: "/private/profile",
        issues: [{ message: "secret" }],
        summary: { errors: 0, warnings: 1, infos: 0 },
      }),
      now: sequenceClock(0, 25),
    });
    expect(result.code).toBe("HEALTHY");
    expect(result.summary).toEqual({
      desktop_status: "healthy",
      runtime_status: "healthy",
      gateway_status: "healthy",
      code: "HEALTHY",
      duration_ms: 25,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|private|message|issues|profile/i,
    );
  });

  it("returns a bounded timeout result", async () => {
    const result = await runDesktopControlHealthProbe(
      {
        getRuntimeInvocation: () => ({ available: true }),
        isGatewayHealthy: () => new Promise<boolean>(() => undefined),
        runConfigHealthCheck: () => ({
          ranAt: 0,
          issues: [],
          summary: { errors: 0, warnings: 0, infos: 0 },
        }),
        now: sequenceClock(0, 20),
      },
      1,
    );
    expect(result.code).toBe("HEALTH_CHECK_TIMEOUT");
    expect(result.summary.gateway_status).toBe("unknown");
  });
});

function sequenceClock(...values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
