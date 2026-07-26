import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_HEALTH_UPDATED_EVENT,
  ConfigHealthBanner,
} from "./ConfigHealthBanner";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, number>) =>
      vars?.count !== undefined ? `${key}:${vars.count}` : key,
  }),
}));

function report(
  issues: Array<{
    code?: string;
    severity: "error" | "warning" | "info";
  }>,
  profile = "default",
): {
  ranAt: number;
  profile: string;
  issues: Array<{
    code?: string;
    severity: "error" | "warning" | "info";
  }>;
  summary: { errors: number; warnings: number; infos: number };
} {
  return {
    ranAt: Date.now(),
    profile,
    issues,
    summary: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      infos: issues.filter((issue) => issue.severity === "info").length,
    },
  };
}

describe("ConfigHealthBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getConfigHealth: vi
          .fn()
          .mockResolvedValue(report([{ severity: "warning" }])),
        getConnectionConfig: vi.fn().mockResolvedValue({ mode: "local" }),
        getApiServerKeyStatus: vi
          .fn()
          .mockResolvedValue({ hasKey: true, providerId: "env" }),
        invalidateSecretsCache: vi.fn().mockResolvedValue(undefined),
        generateApiServerKey: vi.fn().mockResolvedValue({ generated: true }),
        rerunConfigHealth: vi.fn().mockResolvedValue(report([])),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("hides when Settings publishes a clean config-health report", async () => {
    render(<ConfigHealthBanner profile="default" />);

    expect(await screen.findByTestId("config-health-banner")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CONFIG_HEALTH_UPDATED_EVENT, {
          detail: report([], "default"),
        }),
      );
    });

    expect(screen.queryByTestId("config-health-banner")).toBeNull();
  });

  it("hides when the report only contains info-level issues", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getConfigHealth: vi
          .fn()
          .mockResolvedValue(report([{ severity: "info" }])),
      },
    });

    render(<ConfigHealthBanner profile="default" />);

    await act(async () => {
      await new Promise((r) => window.setTimeout(r, 10));
    });

    expect(screen.queryByTestId("config-health-banner")).toBeNull();
  });

  it("ignores config-health updates for another profile", async () => {
    render(<ConfigHealthBanner profile="default" />);

    expect(await screen.findByTestId("config-health-banner")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CONFIG_HEALTH_UPDATED_EVENT, {
          detail: report([], "other-profile"),
        }),
      );
    });

    expect(screen.getByTestId("config-health-banner")).toBeTruthy();
  });

  it("automatically creates a missing local gateway credential once and hides the banner", async () => {
    const missing = report([
      { code: "EMPTY_API_SERVER_KEY", severity: "warning" },
    ]);
    const api = {
      getConfigHealth: vi.fn().mockResolvedValue(missing),
      getConnectionConfig: vi.fn().mockResolvedValue({ mode: "local" }),
      getApiServerKeyStatus: vi
        .fn()
        .mockResolvedValue({ hasKey: false, providerId: "env" }),
      invalidateSecretsCache: vi.fn().mockResolvedValue(undefined),
      generateApiServerKey: vi.fn().mockResolvedValue({ generated: true }),
      rerunConfigHealth: vi.fn().mockResolvedValue(report([])),
    };
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });

    render(<ConfigHealthBanner profile="default" />);

    expect(
      await screen.findByText("diagnose.localConnection.preparing"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(api.generateApiServerKey).toHaveBeenCalledTimes(1);
      expect(api.rerunConfigHealth).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("config-health-banner")).toBeNull();
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CONFIG_HEALTH_UPDATED_EVENT, { detail: missing }),
      );
    });
    expect(api.generateApiServerKey).toHaveBeenCalledTimes(1);
  });

  it("offers automatic repair after the first local repair attempt fails", async () => {
    const missing = report([
      { code: "EMPTY_API_SERVER_KEY", severity: "warning" },
    ]);
    const api = {
      getConfigHealth: vi.fn().mockResolvedValue(missing),
      getConnectionConfig: vi.fn().mockResolvedValue({ mode: "local" }),
      getApiServerKeyStatus: vi
        .fn()
        .mockResolvedValue({ hasKey: false, providerId: "env" }),
      invalidateSecretsCache: vi.fn().mockResolvedValue(undefined),
      generateApiServerKey: vi
        .fn()
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValueOnce({ generated: true }),
      rerunConfigHealth: vi.fn().mockResolvedValue(report([])),
    };
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });

    render(<ConfigHealthBanner profile="default" />);

    expect(
      await screen.findByText("diagnose.localConnection.notReady"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("diagnose.localConnection.autoFix"));

    await waitFor(() => {
      expect(api.generateApiServerKey).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("config-health-banner")).toBeNull();
    });
  });

  it("does not write a local credential for Remote mode", async () => {
    const missing = report([
      { code: "EMPTY_API_SERVER_KEY", severity: "warning" },
    ]);
    const api = {
      getConfigHealth: vi.fn().mockResolvedValue(missing),
      getConnectionConfig: vi.fn().mockResolvedValue({ mode: "remote" }),
      getApiServerKeyStatus: vi.fn(),
      invalidateSecretsCache: vi.fn(),
      generateApiServerKey: vi.fn(),
      rerunConfigHealth: vi.fn(),
    };
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });

    render(<ConfigHealthBanner profile="default" />);

    await waitFor(() => {
      expect(screen.queryByTestId("config-health-banner")).toBeNull();
    });
    expect(api.getApiServerKeyStatus).not.toHaveBeenCalled();
    expect(api.generateApiServerKey).not.toHaveBeenCalled();
  });

  it("refreshes but never overwrites a command-backed secrets provider", async () => {
    const missing = report([
      { code: "EMPTY_API_SERVER_KEY", severity: "warning" },
    ]);
    const api = {
      getConfigHealth: vi.fn().mockResolvedValue(missing),
      getConnectionConfig: vi.fn().mockResolvedValue({ mode: "local" }),
      getApiServerKeyStatus: vi
        .fn()
        .mockResolvedValue({ hasKey: false, providerId: "command" }),
      invalidateSecretsCache: vi.fn().mockResolvedValue(undefined),
      generateApiServerKey: vi.fn(),
      rerunConfigHealth: vi.fn(),
    };
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });

    render(<ConfigHealthBanner profile="default" />);

    expect(
      await screen.findByText("diagnose.localConnection.notReady"),
    ).toBeTruthy();
    expect(api.invalidateSecretsCache).toHaveBeenCalledTimes(1);
    expect(api.getApiServerKeyStatus).toHaveBeenCalledTimes(2);
    expect(api.generateApiServerKey).not.toHaveBeenCalled();
  });
});
