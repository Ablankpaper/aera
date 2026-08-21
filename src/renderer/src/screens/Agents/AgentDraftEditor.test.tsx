import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      schemaVersion: 2,
      identity: { systemPrompt: "Research carefully" },
      assets: [
        {
          path: "knowledge/notes.md",
          kind: "knowledge",
          mediaType: "text/markdown",
        },
      ],
      modelPolicy: {
        mode: "user_select",
        allowedProviders: [],
        allowedModels: [],
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
  prepareOrganizationSubmission: ReturnType<typeof vi.fn>;
  confirmOrganizationSubmission: ReturnType<typeof vi.fn>;
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
    prepareOrganizationSubmission: vi.fn(),
    confirmOrganizationSubmission: vi.fn(),
    listOrganizationSubmissions: vi.fn(),
    getOrganizationSubmission: vi.fn(),
    prepareOrganizationReview: vi.fn(),
    confirmOrganizationReview: vi.fn(),
    prepareOrganizationWithdrawal: vi.fn(),
    confirmOrganizationWithdrawal: vi.fn(),
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
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "hermesAPI");
  });

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

  it("keeps model selection optional while importing identity and capability Markdown", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.example.test/v1",
        })),
        listModels: vi.fn(async () => [
          {
            id: "custom-gpt-56-sol",
            name: "Production model",
            provider: "custom",
            providerLabel: "Private gateway",
            model: "gpt-5.6-sol",
            baseUrl: "https://api.example.test/v1",
            createdAt: 1,
          },
          {
            id: "unconfigured-openai",
            name: "Unconfigured OpenAI",
            provider: "openai",
            model: "gpt-5.6",
            baseUrl: "https://api.openai.com/v1",
            createdAt: 2,
          },
        ]),
      },
    });
    const created = detail();
    const api = installAPI({
      createDraft: vi.fn(async () => success(created)),
    });
    render(
      <AgentDraftEditor
        open
        draft={null}
        modelProfileId="default"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    expect(screen.queryByLabelText("agents.control.runtimeModel")).toBeNull();
    expect(
      screen.getByText("agents.control.runtimeModelChosenOnUse"),
    ).toBeInTheDocument();
    const identityFile = new File(
      ["# Video Producer\nYou plan short-form product videos."],
      "video-producer.md",
      { type: "text/markdown" },
    );
    Object.defineProperty(identityFile, "text", {
      value: async () =>
        "# Video Producer\nYou plan short-form product videos.",
    });
    fireEvent.change(screen.getByLabelText("agents.control.identityUpload"), {
      target: { files: [identityFile] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("agents.control.systemPrompt")).toHaveValue(
        "# Video Producer\nYou plan short-form product videos.",
      ),
    );
    expect(screen.getByLabelText("agents.control.name")).toHaveValue(
      "video-producer",
    );

    const skillFile = new File(
      ["# Research\nAlways verify primary sources."],
      "research.md",
      { type: "text/markdown" },
    );
    Object.defineProperty(skillFile, "text", {
      value: async () => "# Research\nAlways verify primary sources.",
    });
    fireEvent.change(
      screen.getAllByLabelText("agents.control.assetUpload")[0],
      {
        target: { files: [skillFile] },
      },
    );
    await waitFor(() =>
      expect(screen.getByLabelText("agents.control.assetContent")).toHaveValue(
        "# Research\nAlways verify primary sources.",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));
    expect(api.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "video-producer",
        manifest: expect.objectContaining({
          identity: {
            systemPrompt:
              "# Video Producer\nYou plan short-form product videos.",
          },
          modelPolicy: {
            mode: "user_select",
            allowedProviders: [],
            allowedModels: [],
          },
          assets: [
            {
              path: "skills/research/SKILL.md",
              kind: "skill",
              mediaType: "text/markdown",
            },
          ],
        }),
        assets: [
          {
            path: "skills/research/SKILL.md",
            content: "# Research\nAlways verify primary sources.",
          },
        ],
      }),
      undefined,
    );
  });

  it("saves installed Skill and MCP choices as a later V3 draft revision and reopens them", async () => {
    const source = detail();
    source.manifest = {
      schemaVersion: 3,
      identity: { systemPrompt: "Research carefully" },
      assets: [...source.manifest.assets],
      modelPolicy: {
        mode: "user_select",
        allowedProviders: [],
        allowedModels: [],
      },
      mcpRequirements: [],
      tools: { allowed: ["docs.read"], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    };
    source.publishedRevision = {
      revision: source.revision,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
    };
    const saved = structuredClone(source);
    saved.revision = 2;
    if (saved.manifest.schemaVersion !== 3) throw new Error("V3 required");
    saved.manifest.assets.push({
      path: "skills/weekly-summary/SKILL.md",
      kind: "skill",
      mediaType: "text/markdown",
    });
    saved.manifest.mcpRequirements = [
      {
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read employee-selected documents",
      },
    ];
    saved.assets.push({
      path: "skills/weekly-summary/SKILL.md",
      kind: "skill",
      mediaType: "text/markdown",
      sizeBytes: 17,
      sha256: "b".repeat(64),
    });
    saved.editableAssets.push({
      path: "skills/weekly-summary/SKILL.md",
      content: "# Weekly summary\n",
    });
    const api = installAPI({
      listAuthoringCapabilities: vi.fn(async () =>
        success({
          profile: {
            profileHandle: "profile-a",
            displayName: "Profile A",
          },
          skills: [
            {
              name: "weekly-summary",
              category: "writing",
              description: "Draft summaries",
            },
          ],
          mcpServers: [],
        }),
      ),
      prepareInstalledSkillSnapshot: vi.fn(async () =>
        success({
          snapshotHandle: HANDLE_ID,
          profileHandle: "profile-a",
          skillName: "weekly-summary",
          category: "writing",
          description: "Draft summaries",
          files: [
            {
              draftLocation: "skills/weekly-summary/SKILL.md",
              mediaType: "text/markdown" as const,
              sizeBytes: 17,
              sha256: "b".repeat(64),
            },
          ],
          fileCount: 1,
          totalBytes: 17,
          contentDigest: "c".repeat(64),
          findings: [],
          expiresAt: "2026-08-06T00:10:00.000Z",
        }),
      ),
      confirmInstalledSkillSnapshot: vi.fn(async () =>
        success([
          {
            path: "skills/weekly-summary/SKILL.md",
            content: "# Weekly summary\n",
          },
        ]),
      ),
      updateDraft: vi.fn(async () => success(saved)),
    });
    const { rerender } = render(
      <AgentDraftEditor
        open
        draft={source}
        capabilityProfiles={[
          { profileHandle: "profile-a", displayName: "Profile A" },
        ]}
        modelProfileId="profile-a"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.chooseInstalled",
      }),
    );
    fireEvent.change(
      await screen.findByLabelText(
        "agents.control.capabilities.installedSkill",
      ),
      { target: { value: "weekly-summary" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.previewSkill",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "agents.control.capabilities.addSkill",
      }),
    );
    await waitFor(() =>
      expect(api.confirmInstalledSkillSnapshot).toHaveBeenCalledTimes(1),
    );
    const saveButton = screen.getByRole("button", {
      name: "agents.control.saveLocal",
    });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    expect(api.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        manifest: expect.objectContaining({
          schemaVersion: 3,
          assets: expect.arrayContaining([
            expect.objectContaining({
              path: "skills/weekly-summary/SKILL.md",
            }),
          ]),
        }),
      }),
      undefined,
    );

    rerender(
      <AgentDraftEditor
        open
        draft={saved}
        capabilityProfiles={[
          { profileHandle: "profile-a", displayName: "Profile A" },
        ]}
        modelProfileId="profile-a"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );
    expect(
      screen.getByText("agents.control.capabilities.selectedCapabilities"),
    ).toBeInTheDocument();
  });

  it("does not expose legacy allowlist controls as an Agent model lock", async () => {
    const catalogModels = [
      "gpt-5.6-sol",
      "codex-auto-review",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-openai-compact",
      ...Array.from({ length: 12 }, (_, index) => `catalog-model-${index + 7}`),
    ];
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "custom:gpt",
          model: "gpt-5.6-sol",
          baseUrl: "https://current-gateway.example.test/v1",
        })),
        listModels: vi.fn(async () => [
          ...catalogModels.map((model, index) => ({
            id: `gpt-${index}`,
            name: model,
            provider: "custom",
            providerLabel: "GPT",
            model,
            baseUrl: "https://current-gateway.example.test/v1",
            createdAt: index + 1,
          })),
          {
            id: "old-route-model",
            name: "Old route model",
            provider: "custom",
            providerLabel: "Old GPT",
            model: "old-fixed-model",
            baseUrl: "https://old-gateway.example.test/v1",
            createdAt: 99,
          },
        ]),
      },
    });
    const configuredDraft = detail();
    if (configuredDraft.manifest.schemaVersion !== 2) {
      throw new Error("V2 fixture required");
    }
    configuredDraft.manifest.modelPolicy = {
      mode: "allowlist",
      allowedProviders: ["custom:gpt"],
      allowedModels: ["gpt-5.6-sol"],
    };
    installAPI();

    render(
      <AgentDraftEditor
        open
        draft={configuredDraft}
        modelProfileId="active-installed-agent"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    await screen.findByText("agents.control.runtimeModelChosenOnUse");
    expect(
      screen.queryByLabelText("agents.control.modelPolicyMode"),
    ).toBeNull();
    expect(screen.queryByLabelText("agents.control.runtimeModel")).toBeNull();
  });

  it("normalizes an editable legacy allowlist to user-selected runtime models", async () => {
    const saved = detail(2);
    const api = installAPI({
      updateDraft: vi.fn(async () => success(saved)),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        modelProfileId="account-home"
        runtimeModelRoutes={[
          {
            id: "petoi-route",
            sourceProfileId: "account-home",
            modelLibraryId: "petoi-model",
            provider: "custom:petoi",
            providerLabel: "Petoi",
            model: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            baseUrl: "https://api.petoi.cn/v1",
          },
          {
            id: "yundu-route",
            sourceProfileId: "account-home",
            modelLibraryId: "yundu-model",
            provider: "custom:yundu.lat",
            providerLabel: "yundu.lat",
            model: "claude-opus-4-6",
            displayName: "claude-opus-4-6",
            baseUrl: "https://yundu.lat/v1",
          },
        ]}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("agents.control.name"), {
      target: { value: "Research Agent Updated" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );

    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledOnce());
    expect(api.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          modelPolicy: {
            mode: "user_select",
            allowedProviders: [],
            allowedModels: [],
          },
        }),
      }),
      undefined,
    );
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

    fireEvent.change(screen.getByLabelText("agents.control.name"), {
      target: { value: "Research Agent Updated" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.saveLocal" }),
    );
    await waitFor(() =>
      expect(screen.getByText("agents.control.errors.conflict")).toBeTruthy(),
    );
    expect(api.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: DRAFT_ID, expectedRevision: 2 }),
      undefined,
    );
    expectNoRendererOwnershipInput(api.updateDraft);
  });

  it("publishes a personal Agent in one explicit action and excludes private Hermes data", async () => {
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
    await waitFor(() =>
      expect(api.confirmPublication).toHaveBeenCalledWith(HANDLE_ID, undefined),
    );
    expect(screen.getByText("agents.control.publishOnlySuccess")).toBeTruthy();
    expect(api.updateDraft).not.toHaveBeenCalled();
    expectNoRendererOwnershipInput(api.preparePublication);
    expectNoRendererOwnershipInput(api.confirmPublication);
  });

  it("keeps an Organization shell context while publishing explicitly scoped USER assets", async () => {
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
      preparePublication: vi.fn(async () =>
        success({
          publicationHandle: HANDLE_ID,
          draftId: DRAFT_ID,
          revision: 2,
          targetScope: "USER" as const,
          assetCounts: { skill: 0, sop: 0, knowledge: 0 },
          totalBytes: 0,
        }),
      ),
      confirmPublication: vi.fn(async () => success(published)),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        operationScope="USER"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publish" }),
    );
    await waitFor(() =>
      expect(api.confirmPublication).toHaveBeenCalledWith(HANDLE_ID, "USER"),
    );
    expect(api.preparePublication).toHaveBeenCalledWith(DRAFT_ID, "USER");
  });

  it("prevents republishing the same unchanged signed revision", () => {
    const published = detail(2);
    published.publishedRevision = {
      revision: 2,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
    };
    render(
      <AgentDraftEditor
        open
        draft={published}
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "agents.control.publish" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "agents.control.publishAndUse" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByLabelText("agents.control.systemPrompt"), {
      target: { value: "Research carefully with a new revision." },
    });
    expect(
      screen.getByRole("button", { name: "agents.control.publish" }),
    ).toBeEnabled();
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

  it("submits an Organization draft for review without publishing or installing it", async () => {
    const saved = detail(2);
    const api = installAPI({
      updateDraft: vi.fn(async () => success(saved)),
      prepareOrganizationSubmission: vi.fn(async () =>
        success({
          publicationHandle: HANDLE_ID,
          draftId: DRAFT_ID,
          revision: 2,
          kind: "initial" as const,
          definitionId: null,
          baseVersionId: null,
          contentDigest: `sha256:${"b".repeat(64)}`,
          assetCounts: { skill: 0, sop: 0, knowledge: 1 },
          totalBytes: 8,
          expiresAt: "2026-07-21T02:00:00.000Z",
        }),
      ),
      confirmOrganizationSubmission: vi.fn(async () =>
        success({
          id: "55555555-5555-4555-8555-555555555555",
          organizationId: "66666666-6666-4666-8666-666666666666",
          kind: "initial" as const,
          definitionId: DEFINITION_ID,
          baseVersionId: null,
          publishedVersionId: null,
          localDraftId: DRAFT_ID,
          localDraftRevision: 2,
          submittedByUserId: "77777777-7777-4777-8777-777777777777",
          contentDigest: `sha256:${"b".repeat(64)}`,
          status: "pending" as const,
          revision: 1,
          submittedAt: "2026-07-21T01:00:00.000Z",
          terminalAt: null,
          review: null,
        }),
      ),
    });
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        publicationTarget="ORGANIZATION"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onOrganizationSubmitted={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "agents.control.publish" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "agents.control.publishAndUse" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.prepareSubmission",
      }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "agents.control.organization.submissionPreviewTitle",
      }),
    ).toHaveTextContent("agents.control.privateDataExcluded");
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.organization.submitForReview",
      }),
    );

    await waitFor(() =>
      expect(api.confirmOrganizationSubmission).toHaveBeenCalledWith({
        publicationHandle: HANDLE_ID,
        confirmation: "submit-organization-agent",
      }),
    );
    expect(api.preparePublication).not.toHaveBeenCalled();
    expect(api.confirmPublication).not.toHaveBeenCalled();
    expect(api.installVersion).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByText("agents.control.organization.submittedNotPublished"),
      ).toBeVisible(),
    );
    expectNoRendererOwnershipInput(api.prepareOrganizationSubmission);
    expectNoRendererOwnershipInput(api.confirmOrganizationSubmission);
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

  // @lat: [[model-selection#Installed-Agent route selection uses an owner catalog]]
  it("publishes and starts personal Agent setup in one explicit action", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.example.test/v1",
        })),
        listModels: vi.fn(async () => []),
      },
    });
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
    const onClose = vi.fn();
    const onRequestInstall = vi.fn();
    render(
      <AgentDraftEditor
        open
        draft={detail()}
        modelProfileId="account-home"
        runtimeModelRoutes={[
          {
            id: "account-home\0petoi-model",
            sourceProfileId: "account-home",
            provider: "custom:petoi",
            providerLabel: "Petoi",
            model: "gpt-5.6-sol",
            displayName: "gpt-5.6-sol",
            baseUrl: "https://api.petoi.cn/v1",
            apiMode: "chat_completions",
            sourceKind: "account",
            selection: {
              sourceProfileId: "account-home",
              modelLibraryId: "66666666-6666-4666-8666-666666666666",
              catalogRevision: "a".repeat(64),
            },
          },
        ]}
        onClose={onClose}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={onRequestInstall}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("agents.control.publishAndUseSequence"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "agents.control.publishAndUse" }),
    );
    await waitFor(() =>
      expect(onRequestInstall).toHaveBeenCalledWith({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        displayName: "Research Agent",
        modelSelection: {
          sourceProfileId: "account-home",
          modelLibraryId: "66666666-6666-4666-8666-666666666666",
          catalogRevision: "a".repeat(64),
        },
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onRequestInstall.mock.invocationCallOrder[0],
    );
    expect(
      screen.queryByRole("button", {
        name: "agents.control.confirmPublish",
      }),
    ).toBeNull();
  });

  it("deduplicates a repeated publish-and-use action before the first request settles", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.example.test/v1",
        })),
        listModels: vi.fn(async () => []),
      },
    });
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
        modelProfileId="account-home"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={onRequestInstall}
      />,
    );

    const publishAndUse = await screen.findByRole("button", {
      name: "agents.control.publishAndUse",
    });
    await act(async () => {
      publishAndUse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      publishAndUse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => expect(onRequestInstall).toHaveBeenCalled());
    expect(api.preparePublication).toHaveBeenCalledTimes(1);
    expect(api.confirmPublication).toHaveBeenCalledTimes(1);
    expect(onRequestInstall).toHaveBeenCalledTimes(1);
  });

  it("does not bind a legacy fixed draft to its historical Runtime model", async () => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "custom:aera-e2e",
          model: "aera-e2e-model",
          baseUrl: "http://127.0.0.1:18088/v1",
        })),
        listModels: vi.fn(async () => [
          {
            id: "aera-e2e-model",
            name: "aera-e2e-model",
            provider: "custom",
            providerLabel: "Aera E2E",
            model: "aera-e2e-model",
            baseUrl: "http://127.0.0.1:18088/v1",
            createdAt: 1,
          },
        ]),
      },
    });
    const stale = detail();
    if (stale.manifest.schemaVersion !== 2) {
      throw new Error("V2 fixture required");
    }
    stale.manifest.modelPolicy = {
      mode: "fixed",
      allowedProviders: ["custom:aera-本地-e2e-模型"],
      allowedModels: ["aera-e2e-model"],
    };
    installAPI();

    render(
      <AgentDraftEditor
        open
        draft={stale}
        modelProfileId="account-home"
        onClose={() => undefined}
        onSaved={() => undefined}
        onPublished={() => undefined}
        onRequestInstall={() => undefined}
      />,
    );

    await screen.findByText("agents.control.runtimeModelChosenOnUse");
    expect(screen.queryByLabelText("agents.control.runtimeModel")).toBeNull();
  });

  it("keeps publish and publish-and-use available before a model is selected", () => {
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

    expect(
      screen.getByText("agents.control.runtimeModelChosenOnUse"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "agents.control.publish" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "agents.control.publishAndUse" }),
    ).toBeEnabled();
  });
});
