import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
} from "../../../../shared/agentera-agent-control";
import AgentControlPanel from "./AgentControlPanel";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function definition(): AgenteraAgentDefinitionSummary {
  return {
    id: DEFINITION_ID,
    displayName: "Research Agent",
    status: "active",
    latestVersionId: VERSION_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function installation(
  status: "pending" | "active" = "active",
): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId:
      status === "active" ? "44444444-4444-4444-8444-444444444444" : null,
    policySnapshotId: "55555555-5555-4555-8555-555555555555",
    status,
    retryCode: status === "pending" ? "materialization_failed" : null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

type MockedPanelAgenteraAPI = Window["agenteraAgents"] & {
  listDefinitions: ReturnType<typeof vi.fn>;
  archiveInstallation: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockedPanelAgenteraAPI {
  const api = {
    getState: vi.fn(async () =>
      success({
        access: "online" as const,
        cloudAvailable: true,
        draftCount: 0,
        installationCount: 0,
      }),
    ),
    listDrafts: vi.fn(async () => success([])),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    listDefinitions: vi.fn(async () => success([definition()])),
    listVersions: vi.fn(async () => success([])),
    listInstallations: vi.fn(async () => success([])),
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    archiveInstallation: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as MockedPanelAgenteraAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("AgentControlPanel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps local drafts/installations available offline and pauses cloud discovery", async () => {
    const api = installAPI({
      getState: vi.fn(async () =>
        success({
          access: "offline" as const,
          cloudAvailable: false,
          draftCount: 0,
          installationCount: 1,
        }),
      ),
      listInstallations: vi.fn(async () => success([installation("active")])),
    });
    render(
      <AgentControlPanel profiles={[{ id: "default", name: "Default" }]} />,
    );

    expect(
      await screen.findByText("agents.control.offlineNotice"),
    ).toBeTruthy();
    expect(api.listDefinitions).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("agents.control.installedLocally").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "agents.control.newAgent" }),
    ).toBeEnabled();
  });

  it("shows pending retry and archives without deleting local Profile data", async () => {
    const api = installAPI({
      listInstallations: vi.fn(async () =>
        success([installation("pending"), installation("active")]),
      ),
      archiveInstallation: vi.fn(async () => success(installation("active"))),
    });
    render(
      <AgentControlPanel profiles={[{ id: "default", name: "Default" }]} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "agents.control.retry" }),
    );
    expect(
      screen.getByRole("dialog", { name: "agents.control.retryTitle" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.cancel" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.archive" }),
    );
    const archiveDialog = screen.getByRole("dialog", {
      name: "agents.control.archiveTitle",
    });
    expect(archiveDialog).toHaveTextContent(
      "agents.control.archiveKeepsLocalData",
    );
    expect(api.archiveInstallation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.confirmArchive" }),
    );
    await waitFor(() =>
      expect(api.archiveInstallation).toHaveBeenCalledWith(INSTALLATION_ID),
    );
  });

  it("renders only stable safe error text", async () => {
    installAPI({
      listDefinitions: vi.fn(async () => ({
        ok: false as const,
        errorCode: "cloud_unavailable" as const,
      })),
    });
    render(<AgentControlPanel profiles={[]} />);

    expect(
      await screen.findByText("agents.control.errors.cloud_unavailable"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token|response body|stack/i);
  });
});
