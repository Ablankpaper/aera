import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
} from "../../../../shared/agentera-agent-control";
import AgentDraftEditor from "./AgentDraftEditor";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const HANDLE_ID = "44444444-4444-4444-8444-444444444444";

function expectNoRendererOwnershipInput(mock: ReturnType<typeof vi.fn>): void {
  expect(JSON.stringify(mock.mock.calls)).not.toMatch(
    /workspaceId|workspace_id|ownerScope|owner_scope|role/i,
  );
}

function detail(revision = 1): AgentDraftDetail {
  return {
    id: DRAFT_ID,
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Research carefully" },
      assets: [
        {
          path: "knowledge/notes.md",
          kind: "knowledge",
          mediaType: "text/markdown",
        },
      ],
      modelConstraints: {
        allowedProviders: ["openai"],
        allowedModels: ["gpt-5.6"],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    },
    assets: [
      {
        path: "knowledge/notes.md",
        kind: "knowledge",
        mediaType: "text/markdown",
        sizeBytes: 8,
        sha256: "a".repeat(64),
      },
    ],
    editableAssets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
    revision,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastPublicationAttempt: null,
    publishedRevision: null,
  };
}

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

type MockedEditorAgenteraAPI = Window["agenteraAgents"] & {
  createDraft: ReturnType<typeof vi.fn>;
  updateDraft: ReturnType<typeof vi.fn>;
  preparePublication: ReturnType<typeof vi.fn>;
  confirmPublication: ReturnType<typeof vi.fn>;
  installVersion: ReturnType<typeof vi.fn>;
};

function installAPI(
  overrides: Partial<Window["agenteraAgents"]> = {},
): MockedEditorAgenteraAPI {
  const api = {
    getState: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    preparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    listDefinitions: vi.fn(),
    listVersions: vi.fn(),
    listInstallations: vi.fn(),
    installVersion: vi.fn(),
    claimVersion: vi.fn(),
    retryPendingInstallation: vi.fn(),
    selectInstallationVersion: vi.fn(),
    archiveInstallation: vi.fn(),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as MockedEditorAgenteraAPI;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("AgentDraftEditor", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("creates a local draft without making any publication or installation call", async () => {
    const created = detail();
    const api = installAPI({
      createDraft: vi.fn(async () => success(created)),
    });
    const onSaved = vi.fn();
    render(
      <AgentDraftEditor
        open
        draft={null}
        onClose={() => undefined}
        onSaved={onSaved}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("agents.control.name"), {
      target: { value: "Research Agent" },
    });
    fireEvent.change(screen.getByLabelText("agents.control.systemPrompt"), {
      target: { value: "Research carefully" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );

    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));
    expect(api.preparePublication).not.toHaveBeenCalled();
    expect(api.confirmPublication).not.toHaveBeenCalled();
    expect(api.installVersion).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(created);
    expectNoRendererOwnershipInput(api.createDraft);
  });

  it("shows a stable conflict message for a stale local revision", async () => {
    const api = installAPI({
      updateDraft: vi.fn(async () => ({
        ok: false as const,
        errorCode: "conflict" as const,
      })),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail(2)}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );
    await waitFor(() =>
      expect(screen.getByText("agents.control.errors.conflict")).toBeTruthy(),
    );
    expect(api.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: DRAFT_ID, expectedRevision: 2 }),
    );
    expectNoRendererOwnershipInput(api.updateDraft);
  });

  it("previews exact publication categories and excludes private Hermes data", async () => {
    const saved = detail(2);
    const published = {
      draftId: DRAFT_ID,
      revision: 2,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      versionNumber: 1,
      contentDigest: "b".repeat(64),
      publishedAt: "2026-07-19T01:00:00.000Z",
      replayed: false,
    };
    const api = installAPI({
      updateDraft: vi.fn(async () => success(saved)),
      preparePublication: vi.fn(async () =>
        success({
          publicationHandle: HANDLE_ID,
          draftId: DRAFT_ID,
          revision: 2,
          targetScope: "USER" as const,
          assetCounts: { skill: 2, sop: 1, knowledge: 3 },
          totalBytes: 4096,
        }),
      ),
      confirmPublication: vi.fn(async () => success(published)),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publish" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "agents.control.publishPreviewTitle",
    });
    expect(dialog).toHaveTextContent("agents.control.personalSpace");
    expect(dialog).toHaveTextContent("2");
    expect(dialog).toHaveTextContent("1");
    expect(dialog).toHaveTextContent("3");
    expect(dialog).toHaveTextContent("4096");
    expect(dialog).toHaveTextContent("agents.control.privateDataExcluded");

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.confirmPublish" }),
    );
    await waitFor(() =>
      expect(api.confirmPublication).toHaveBeenCalledWith(HANDLE_ID),
    );
    expect(screen.getByText("agents.control.publishOnlySuccess")).toBeTruthy();
    expectNoRendererOwnershipInput(api.updateDraft);
    expectNoRendererOwnershipInput(api.preparePublication);
    expectNoRendererOwnershipInput(api.confirmPublication);
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Role-aware presentation]]
  it("shows the trusted Workspace target returned by the publication preview", async () => {
    const saved = detail(2);
    installAPI({
      updateDraft: vi.fn(async () => success(saved)),
      preparePublication: vi.fn(async () =>
        success({
          publicationHandle: HANDLE_ID,
          draftId: DRAFT_ID,
          revision: 2,
          targetScope: "WORKSPACE" as const,
          assetCounts: { skill: 0, sop: 0, knowledge: 1 },
          totalBytes: 8,
        }),
      ),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publish" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "agents.control.publishPreviewTitle",
    });
    expect(dialog).toHaveTextContent("agents.control.workspaceSpace");
    expect(dialog).not.toHaveTextContent("agents.control.personalSpace");
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Role-aware presentation]]
  it("renders an offline Workspace draft as read-only and makes no mutation call", () => {
    const api = installAPI();
    render(
      <AgentDraftEditor
        open
        readOnly
        draft={detail()}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    expect(screen.getByLabelText("agents.control.name")).toBeDisabled();
    expect(screen.getByLabelText("agents.control.systemPrompt")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "agents.control.publish" }),
    ).toBeDisabled();
    expect(
      screen.getByText("agents.control.workspaceDraftReadOnly"),
    ).toBeTruthy();
    expect(api.createDraft).not.toHaveBeenCalled();
    expect(api.updateDraft).not.toHaveBeenCalled();
    expect(api.preparePublication).not.toHaveBeenCalled();
  });

  it("keeps publish-and-use visibly sequential and requests install only after publish", async () => {
    const saved = detail(2);
    const published = {
      draftId: DRAFT_ID,
      revision: 2,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      versionNumber: 1,
      contentDigest: "b".repeat(64),
      publishedAt: "2026-07-19T01:00:00.000Z",
      replayed: false,
    };
    installAPI({
      updateDraft: vi.fn(async () => success(saved)),
      preparePublication: vi.fn(async () =>
        success({
          publicationHandle: HANDLE_ID,
          draftId: DRAFT_ID,
          revision: 2,
          targetScope: "USER" as const,
          assetCounts: { skill: 0, sop: 0, knowledge: 1 },
          totalBytes: 8,
        }),
      ),
      confirmPublication: vi.fn(async () => success(published)),
    });
    const onRequestInstall = vi.fn();
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={onRequestInstall}
      />,
    );

    expect(
      screen.getByText("agents.control.publishAndUseSequence"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publishAndUse" }),
    );
    expect(onRequestInstall).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.confirmPublish",
      }),
    );
    await waitFor(() =>
      expect(onRequestInstall).toHaveBeenCalledWith({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
      }),
    );
  });
});
