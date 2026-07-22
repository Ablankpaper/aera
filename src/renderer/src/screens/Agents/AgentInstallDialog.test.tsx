import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
} from "../../../../shared/agentera-agent-control";
import AgentInstallDialog from "./AgentInstallDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const INSTALLATION_ID = "44444444-4444-4444-8444-444444444444";

function installation(
  status: "pending" | "active" = "active",
): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "USER",
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId:
      status === "active" ? "55555555-5555-4555-8555-555555555555" : null,
    policySnapshotId: "66666666-6666-4666-8666-666666666666",
    status,
    retryCode: status === "pending" ? "materialization_failed" : null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function version(id: string, number: number): AgenteraAgentVersionSummary {
  return {
    id,
    definitionId: DEFINITION_ID,
    versionNumber: number,
    contentDigest: "a".repeat(64),
    publishedAt: "2026-07-19T00:00:00.000Z",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    assetCounts: { skill: 0, sop: 0, knowledge: 0 },
  };
}

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

type MockedInstallAgenteraAPI = Window["agenteraAgents"] & {
  installVersion: ReturnType<typeof vi.fn>;
  claimVersion: ReturnType<typeof vi.fn>;
  retryPendingInstallation: ReturnType<typeof vi.fn>;
  selectInstallationVersion: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockedInstallAgenteraAPI {
  const api = {
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    ...overrides,
  } as unknown as MockedInstallAgenteraAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

const profiles = [
  { id: "default", name: "Default" },
  { id: "research", name: "Research" },
];

describe("AgentInstallDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("offers only a fresh isolated Profile or an explicit existing-Profile claim", async () => {
    const result = installation();
    const api = installAPI({
      installVersion: vi.fn(async () => success(result)),
      claimVersion: vi.fn(async () => success(result)),
    });
    const onCompleted = vi.fn();
    const { rerender } = render(
      <AgentInstallDialog
        open
        mode="install"
        definitionId={DEFINITION_ID}
        versionId={VERSION_ID}
        installation={null}
        versions={[]}
        profiles={profiles}
        onClose={() => undefined}
        onCompleted={onCompleted}
      />,
    );

    expect(screen.getByText("agents.control.freshProfile")).toBeTruthy();
    expect(screen.getByText("agents.control.claimProfile")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /clone/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("agents.control.profileName"), {
      target: { value: "isolated-agent" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.install" }),
    );
    await waitFor(() =>
      expect(api.installVersion).toHaveBeenCalledWith({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "isolated-agent",
      }),
    );

    rerender(
      <AgentInstallDialog
        open
        mode="install"
        definitionId={DEFINITION_ID}
        versionId={VERSION_ID}
        installation={null}
        versions={[]}
        profiles={profiles}
        onClose={() => undefined}
        onCompleted={onCompleted}
      />,
    );
    fireEvent.click(screen.getByLabelText("agents.control.claimProfile"));
    fireEvent.change(screen.getByLabelText("agents.control.localProfile"), {
      target: { value: "research" },
    });
    expect(
      screen.getByRole("button", { name: "agents.control.install" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByLabelText("agents.control.claimConfirmation"));
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.install" }),
    );
    await waitFor(() =>
      expect(api.claimVersion).toHaveBeenCalledWith({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        localProfileId: "research",
        confirmation: "claim-existing-profile",
      }),
    );
  });

  it("retries a pending installation without offering Profile deletion", async () => {
    const pending = installation("pending");
    const api = installAPI({
      retryPendingInstallation: vi.fn(async () => success(installation())),
    });
    render(
      <AgentInstallDialog
        open
        mode="retry"
        definitionId={DEFINITION_ID}
        versionId={VERSION_ID}
        installation={pending}
        versions={[]}
        profiles={profiles}
        onClose={() => undefined}
        onCompleted={() => undefined}
      />,
    );

    expect(screen.queryByText(/delete/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("agents.control.profileName"), {
      target: { value: "retry-agent" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.retry" }),
    );
    await waitFor(() =>
      expect(api.retryPendingInstallation).toHaveBeenCalledWith({
        id: INSTALLATION_ID,
        target: { kind: "fresh", profileName: "retry-agent" },
      }),
    );
  });

  it("states that manual updates affect only later conversations", async () => {
    const current = installation();
    const api = installAPI({
      selectInstallationVersion: vi.fn(async () => success(current)),
    });
    render(
      <AgentInstallDialog
        open
        mode="update"
        definitionId={DEFINITION_ID}
        versionId={NEXT_VERSION_ID}
        installation={current}
        versions={[version(VERSION_ID, 1), version(NEXT_VERSION_ID, 2)]}
        profiles={profiles}
        onClose={() => undefined}
        onCompleted={() => undefined}
      />,
    );

    expect(
      screen.getByText("agents.control.updateNewConversationsOnly"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("agents.control.version"), {
      target: { value: NEXT_VERSION_ID },
    });
    fireEvent.change(screen.getByLabelText("agents.control.localProfile"), {
      target: { value: "research" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.selectVersion" }),
    );
    await waitFor(() =>
      expect(api.selectInstallationVersion).toHaveBeenCalledWith({
        id: INSTALLATION_ID,
        versionId: NEXT_VERSION_ID,
        localProfileId: "research",
      }),
    );
  });
});
