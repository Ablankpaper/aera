import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeDistributionPublicState } from "../../../../shared/agentera-runtime-distribution";

const mocked = vi.hoisted(() => ({
  state: null as RuntimeDistributionPublicState | null,
  checkForUpdate: vi.fn(async () => undefined),
  downloadConfirmed: vi.fn(async () => undefined),
  cancelDownload: vi.fn(async () => undefined),
  restartToApply: vi.fn(async () => undefined),
  retryRepair: vi.fn(async () => undefined),
}));

vi.mock("./useRuntimeDistribution", () => ({
  useRuntimeDistribution: () => mocked,
}));

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

import RuntimeDistributionCard from "./RuntimeDistributionCard";

function state(
  phase: RuntimeDistributionPublicState["phase"],
  overrides: Partial<RuntimeDistributionPublicState> = {},
): RuntimeDistributionPublicState {
  return {
    phase,
    currentVersion: "0.18.2-agentera.1",
    currentSourceCommit: "abcdef1234567890abcdef1234567890abcdef12",
    packagedSeedVersion: "0.18.2-agentera.1",
    availableVersion: null,
    downloadSize: null,
    downloadPercent: null,
    lastCheckedAt: "2026-07-18T14:00:00.000Z",
    lastErrorCode: null,
    canCheck: phase === "current",
    canDownload: phase === "update-available",
    canCancel: phase === "downloading",
    canRestart: phase === "candidate-ready",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.state = state("current");
});

describe("RuntimeDistributionCard", () => {
  it("renders current, checking, downloading, and candidate-ready actions", () => {
    const view = render(<RuntimeDistributionCard />);
    expect(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.check",
      }),
    ).toBeEnabled();

    mocked.state = state("checking", { canCheck: false });
    view.rerender(<RuntimeDistributionCard />);
    expect(
      screen.getByText("settings.runtimeDistribution.status.checking"),
    ).toBeInTheDocument();

    mocked.state = state("downloading", {
      downloadPercent: 42,
      canCancel: true,
    });
    view.rerender(<RuntimeDistributionCard />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.cancel",
      }),
    );
    expect(mocked.cancelDownload).toHaveBeenCalledOnce();

    mocked.state = state("candidate-ready", {
      availableVersion: "0.19.0-agentera.1",
      canRestart: true,
    });
    view.rerender(<RuntimeDistributionCard />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.restart",
      }),
    );
    expect(mocked.restartToApply).toHaveBeenCalledOnce();
  });

  it("requires an explicit version/source/size confirmation before downloading", async () => {
    mocked.state = state("update-available", {
      availableVersion: "0.19.0-agentera.1",
      downloadSize: 25 * 1024 * 1024,
      canCheck: false,
      canDownload: true,
    });
    render(<RuntimeDistributionCard />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.download",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("0.19.0-agentera.1");
    expect(dialog).toHaveTextContent("bignormal/aera-runtime");
    expect(dialog).toHaveTextContent("25 MB");
    expect(mocked.downloadConfirmed).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.confirmCancel",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocked.downloadConfirmed).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.download",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.confirmDownload",
      }),
    );
    await waitFor(() =>
      expect(mocked.downloadConfirmed).toHaveBeenCalledOnce(),
    );
  });

  it("shows active-task refusal, rollback, and repair without exposing internals", () => {
    mocked.state = state("candidate-ready", {
      lastErrorCode: "runtime_tasks_active",
      availableVersion: "0.19.0-agentera.1",
      canRestart: true,
    });
    const view = render(<RuntimeDistributionCard />);
    expect(
      screen.getByText(
        "settings.runtimeDistribution.errors.runtime_tasks_active",
      ),
    ).toBeInTheDocument();

    mocked.state = state("rollback", {
      lastErrorCode: "runtime_candidate_health_failed",
      canCheck: false,
    });
    view.rerender(<RuntimeDistributionCard />);
    expect(
      screen.getByText("settings.runtimeDistribution.status.rollback"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.retry",
      }),
    );
    expect(mocked.retryRepair).toHaveBeenCalledOnce();

    mocked.state = state("repair-required", {
      currentVersion: null,
      currentSourceCommit: null,
      lastErrorCode: "runtime_repair_required",
      canCheck: false,
    });
    view.rerender(<RuntimeDistributionCard />);
    expect(
      screen.getByText("settings.runtimeDistribution.status.repairRequired"),
    ).toBeInTheDocument();
  });

  it("shows the legacy local command only for explicit external mode", () => {
    const onExternalUpdate = vi.fn();
    mocked.state = state("current");
    const view = render(
      <RuntimeDistributionCard onExternalUpdate={onExternalUpdate} />,
    );
    expect(
      screen.queryByRole("button", {
        name: "settings.runtimeDistribution.externalUpdate",
      }),
    ).not.toBeInTheDocument();

    mocked.state = state("external", {
      currentVersion: null,
      currentSourceCommit: null,
      canCheck: false,
    });
    view.rerender(
      <RuntimeDistributionCard onExternalUpdate={onExternalUpdate} />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.runtimeDistribution.externalUpdate",
      }),
    );
    expect(onExternalUpdate).toHaveBeenCalledOnce();
  });
});
