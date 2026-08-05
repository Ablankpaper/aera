import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentMcpRequirementV3,
  AgenteraAgentControlResult,
  AuthoringCapabilitySummary,
} from "../../../../shared/agentera-agent-control";
import AgentCapabilityPicker from "./AgentCapabilityPicker";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const SNAPSHOT_HANDLE = "11111111-1111-4111-8111-111111111111";
const REQUIREMENT_HANDLE = "22222222-2222-4222-8222-222222222222";

function success<T>(data: T): AgenteraAgentControlResult<T> {
  return { ok: true, data };
}

function summary(profileHandle: string): AuthoringCapabilitySummary {
  return {
    profile: {
      profileHandle,
      displayName: profileHandle === "profile-a" ? "Profile A" : "Profile B",
    },
    skills: [
      {
        name: "weekly-summary",
        category: "writing",
        description: "Draft weekly summaries",
      },
    ],
    mcpServers: [
      {
        logicalName: "private-docs",
        enabled: true,
        tools: [
          { name: "docs.read", description: "Read documents" },
          { name: "docs.search", description: "Search documents" },
        ],
      },
    ],
  };
}

function installAPI(): Window["agenteraAgents"] &
  Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    listAuthoringCapabilities: vi.fn(async (profileId: string) =>
      success(summary(profileId)),
    ),
    prepareInstalledSkillSnapshot: vi.fn(async () =>
      success({
        snapshotHandle: SNAPSHOT_HANDLE,
        profileHandle: "profile-b",
        skillName: "weekly-summary",
        category: "writing",
        description: "Draft weekly summaries",
        files: [
          {
            draftLocation: "skills/weekly-summary/SKILL.md",
            mediaType: "text/markdown" as const,
            sizeBytes: 16,
            sha256: "a".repeat(64),
          },
        ],
        fileCount: 1,
        totalBytes: 16,
        contentDigest: "b".repeat(64),
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
    prepareMcpRequirement: vi.fn(async () =>
      success({
        requirementHandle: REQUIREMENT_HANDLE,
        profileHandle: "profile-b",
        logicalName: "private-docs",
        tools: [{ name: "docs.read", description: "Read documents" }],
        required: true,
        permissionReason: "Read employee-selected documents",
        expiresAt: "2026-08-06T00:10:00.000Z",
      }),
    ),
    confirmMcpRequirement: vi.fn(async () =>
      success({
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read employee-selected documents",
      }),
    ),
  } as unknown as Window["agenteraAgents"] &
    Record<string, ReturnType<typeof vi.fn>>;
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("AgentCapabilityPicker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("selects a Profile, previews and replaces a Skill, and confirms one logical MCP requirement", async () => {
    const api = installAPI();
    const onApplySkillSnapshot =
      vi.fn<(skillName: string, assets: AgentDraftAssetInput[]) => void>();
    const onAddMcpRequirement =
      vi.fn<(requirement: AgentMcpRequirementV3) => void>();
    render(
      <AgentCapabilityPicker
        profiles={[
          { profileHandle: "profile-a", displayName: "Profile A" },
          { profileHandle: "profile-b", displayName: "Profile B" },
        ]}
        initialProfileId="profile-a"
        existingSkillPrefixes={["skills/weekly-summary/"]}
        existingRequirements={[]}
        onApplySkillSnapshot={onApplySkillSnapshot}
        onAddMcpRequirement={onAddMcpRequirement}
        onRemoveMcpRequirement={() => undefined}
        onError={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.chooseInstalled",
      }),
    );
    await waitFor(() =>
      expect(api.listAuthoringCapabilities).toHaveBeenCalledWith("profile-a"),
    );
    fireEvent.change(
      screen.getByLabelText("agents.control.capabilities.profile"),
      { target: { value: "profile-b" } },
    );
    await waitFor(() =>
      expect(api.listAuthoringCapabilities).toHaveBeenLastCalledWith(
        "profile-b",
      ),
    );

    fireEvent.change(
      screen.getByLabelText("agents.control.capabilities.installedSkill"),
      { target: { value: "weekly-summary" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.previewSkill",
      }),
    );
    expect(
      await screen.findByText("skills/weekly-summary/SKILL.md"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.replaceSkill",
      }),
    );
    await waitFor(() =>
      expect(onApplySkillSnapshot).toHaveBeenCalledWith("weekly-summary", [
        {
          path: "skills/weekly-summary/SKILL.md",
          content: "# Weekly summary\n",
        },
      ]),
    );

    fireEvent.change(
      screen.getByLabelText("agents.control.capabilities.mcpServer"),
      { target: { value: "private-docs" } },
    );
    fireEvent.click(screen.getByLabelText("docs.read"));
    fireEvent.click(
      screen.getByLabelText("agents.control.capabilities.required"),
    );
    fireEvent.change(
      screen.getByLabelText("agents.control.capabilities.permissionReason"),
      { target: { value: "Read employee-selected documents" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.previewMcp",
      }),
    );
    expect(
      await screen.findByText("Read employee-selected documents"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.addMcp",
      }),
    );
    await waitFor(() =>
      expect(onAddMcpRequirement).toHaveBeenCalledWith({
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read employee-selected documents",
      }),
    );
    const calls = [
      ...vi.mocked(api.listAuthoringCapabilities).mock.calls,
      ...vi.mocked(api.prepareInstalledSkillSnapshot).mock.calls,
      ...vi.mocked(api.confirmInstalledSkillSnapshot).mock.calls,
      ...vi.mocked(api.prepareMcpRequirement).mock.calls,
      ...vi.mocked(api.confirmMcpRequirement).mock.calls,
    ];
    expect(JSON.stringify(calls)).not.toMatch(
      /profilePath|url|command|args|env|auth|token|headers/i,
    );
  });

  it("prevents duplicate logical MCP requirements before preparation", async () => {
    const api = installAPI();
    render(
      <AgentCapabilityPicker
        profiles={[{ profileHandle: "profile-a", displayName: "Profile A" }]}
        initialProfileId="profile-a"
        existingSkillPrefixes={[]}
        existingRequirements={[
          {
            logicalName: "private-docs",
            tools: ["docs.read"],
            required: true,
            permissionReason: "Read documents",
          },
        ]}
        onApplySkillSnapshot={() => undefined}
        onAddMcpRequirement={() => undefined}
        onRemoveMcpRequirement={() => undefined}
        onError={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agents.control.capabilities.chooseInstalled",
      }),
    );
    await screen.findByLabelText("agents.control.capabilities.mcpServer");
    fireEvent.change(
      screen.getByLabelText("agents.control.capabilities.mcpServer"),
      { target: { value: "private-docs" } },
    );
    expect(
      screen.getByText("agents.control.capabilities.duplicateMcp"),
    ).toBeInTheDocument();
    expect(api.prepareMcpRequirement).not.toHaveBeenCalled();
  });
});
