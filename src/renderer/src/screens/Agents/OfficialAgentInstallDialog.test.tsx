import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  OfficialAgentInstallPreview,
} from "../../../../shared/agentera-agent-control";
import OfficialAgentInstallDialog from "./OfficialAgentInstallDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const HANDLE_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

const preview: OfficialAgentInstallPreview = {
  installHandle: HANDLE_ID,
  expiresAt: "2026-07-22T00:05:00.000Z",
  agent: {
    definitionId: "33333333-3333-4333-8333-333333333333",
    displayName: "Official Research Agent",
    iconMediaType: null,
    iconDataBase64Url: null,
    versionId: "44444444-4444-4444-8444-444444444444",
    versionNumber: 1,
    releaseId: "55555555-5555-4555-8555-555555555555",
    releaseRevisionId: "66666666-6666-4666-8666-666666666666",
    channel: "stable",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    installationState: "not_installed",
    updateState: "current",
  },
};

function installed(): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "PLATFORM",
    officialReleaseId: preview.agent.releaseId,
    selectedReleaseRevisionId: preview.agent.releaseRevisionId,
    updatePolicy: "managed",
    definitionId: preview.agent.definitionId,
    selectedVersionId: preview.agent.versionId,
    runtimeProfileId: "77777777-7777-4777-8777-777777777777",
    policySnapshotId: "88888888-8888-4888-8888-888888888888",
    status: "active",
    retryCode: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("OfficialAgentInstallDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("confirms only the one-use handle and never offers a Profile picker", async () => {
    const confirmOfficialInstall = vi.fn(
      async (): Promise<
        AgenteraAgentControlResult<AgenteraAgentInstallationSummary>
      > => ({ ok: true, data: installed() }),
    );
    Object.defineProperty(window, "agenteraAgents", {
      configurable: true,
      value: { confirmOfficialInstall },
    });
    const onCompleted = vi.fn();
    render(
      <OfficialAgentInstallDialog
        open
        preview={preview}
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />,
    );

    expect(screen.getByText("Official Research Agent")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByText("agents.control.official.freshProfileBoundary"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.official.confirmInstall",
      }),
    );

    await waitFor(() =>
      expect(confirmOfficialInstall).toHaveBeenCalledWith({
        installHandle: HANDLE_ID,
        confirmation: "install-official-agent",
      }),
    );
    expect(onCompleted).toHaveBeenCalledWith(installed());
  });
});
