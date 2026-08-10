import { getRuntimeInvocation } from "../agentera-runtime-distribution/invocation";
import { runConfigHealthCheck } from "../config-health";
import { getActiveProfileNameSync } from "../utils";
import { isGatewayHealthy } from "../hermes";
import type {
  DesktopHealthCode,
  DesktopHealthSummary,
} from "../../shared/agentera-desktop-control";

export interface DesktopHealthDependencies {
  getRuntimeInvocation: () => unknown;
  isGatewayHealthy: () => Promise<boolean>;
  runConfigHealthCheck: () => {
    summary?: { errors?: number };
  };
  now?: () => number;
}

export interface DesktopHealthResult {
  state: "succeeded" | "failed";
  code: DesktopHealthCode;
  summary: DesktopHealthSummary;
}

const MAX_DURATION_MS = 120_000;

function duration(value: number): number {
  return Math.max(
    0,
    Math.min(MAX_DURATION_MS, Number.isFinite(value) ? Math.round(value) : 0),
  );
}

function summary(
  code: DesktopHealthCode,
  desktopStatus: DesktopHealthSummary["desktop_status"],
  runtimeStatus: DesktopHealthSummary["runtime_status"],
  gatewayStatus: DesktopHealthSummary["gateway_status"],
  durationMs: number,
): DesktopHealthSummary {
  return {
    desktop_status: desktopStatus,
    runtime_status: runtimeStatus,
    gateway_status: gatewayStatus,
    code,
    duration_ms: duration(durationMs),
  };
}

function failed(
  code: DesktopHealthCode,
  desktopStatus: DesktopHealthSummary["desktop_status"],
  runtimeStatus: DesktopHealthSummary["runtime_status"],
  gatewayStatus: DesktopHealthSummary["gateway_status"],
  elapsed: () => number,
): DesktopHealthResult {
  return {
    state: "failed",
    code,
    summary: summary(
      code,
      desktopStatus,
      runtimeStatus,
      gatewayStatus,
      elapsed(),
    ),
  };
}

async function boundedGatewayProbe(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runDesktopControlHealthProbe(
  dependencies: DesktopHealthDependencies,
  timeoutMs = 15_000,
): Promise<DesktopHealthResult> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => duration(now() - startedAt);
  if (!dependencies.getRuntimeInvocation()) {
    return failed(
      "RUNTIME_UNAVAILABLE",
      "healthy",
      "unhealthy",
      "unknown",
      elapsed,
    );
  }
  let report: DesktopHealthDependencies["runConfigHealthCheck"] extends () => infer T
    ? T
    : never;
  try {
    report = dependencies.runConfigHealthCheck();
  } catch {
    return failed(
      "DESKTOP_UNHEALTHY",
      "unhealthy",
      "healthy",
      "unknown",
      elapsed,
    );
  }
  if ((report.summary?.errors ?? 0) > 0) {
    return failed(
      "DESKTOP_UNHEALTHY",
      "unhealthy",
      "healthy",
      "unknown",
      elapsed,
    );
  }
  const gateway = await boundedGatewayProbe(
    dependencies.isGatewayHealthy,
    timeoutMs,
  );
  if (gateway === "timeout") {
    return failed(
      "HEALTH_CHECK_TIMEOUT",
      "healthy",
      "healthy",
      "unknown",
      elapsed,
    );
  }
  if (!gateway) {
    return failed(
      "GATEWAY_UNAVAILABLE",
      "healthy",
      "healthy",
      "unhealthy",
      elapsed,
    );
  }
  return {
    state: "succeeded",
    code: "HEALTHY",
    summary: summary("HEALTHY", "healthy", "healthy", "healthy", elapsed()),
  };
}

export function createDefaultDesktopHealthDependencies(): DesktopHealthDependencies {
  return {
    getRuntimeInvocation,
    isGatewayHealthy: () => isGatewayHealthy(getActiveProfileNameSync()),
    runConfigHealthCheck: () =>
      runConfigHealthCheck(getActiveProfileNameSync()),
  };
}
