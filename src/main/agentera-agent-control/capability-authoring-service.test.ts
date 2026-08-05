// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerInfo } from "../mcp-servers";
import {
  CapabilityAuthoringService,
  CapabilityAuthoringServiceError,
} from "./capability-authoring-service";

let root = "";
let profileA = "";
let profileB = "";
let ownerKey = "owner-a";
let now = new Date("2026-08-06T00:00:00.000Z");
let uuidIndex = 0;

function writeSkill(
  profilePath: string,
  category: string,
  directory: string,
  options: {
    name?: string;
    description?: string;
    files?: Record<string, string | Buffer>;
  } = {},
): string {
  const skillPath = join(profilePath, "skills", category, directory);
  mkdirSync(skillPath, { recursive: true });
  const name = options.name ?? directory;
  const description = options.description ?? `${name} description`;
  writeFileSync(
    join(skillPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const destination = join(skillPath, ...relativePath.split("/"));
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  return skillPath;
}

function mcpServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: "private-docs",
    type: "http",
    transport: "http",
    enabled: true,
    detail: "https://author.internal.example.test/mcp",
    url: "https://author.internal.example.test/mcp",
    args: ["--credential", "author-secret"],
    env: { DOCS_TOKEN: "author-secret-token" },
    auth: "Bearer author-secret-token",
    tools: [
      { name: "docs.read", description: "Read approved documents" },
      { name: "docs.search", description: "Search approved documents" },
      {
        name: "https://author.internal.example.test/private-tool",
        description: "Must never reach the renderer",
      },
    ],
    ...overrides,
  };
}

function service(
  options: {
    skills?: (profileHandle: string) => Array<{
      name: string;
      category: string;
      description: string;
      path: string;
    }>;
    servers?: (profileHandle: string) => Promise<McpServerInfo[]>;
    tools?: (
      logicalName: string,
      profileHandle: string,
    ) => Promise<Array<{ name: string; description: string }>>;
  } = {},
): CapabilityAuthoringService {
  return new CapabilityAuthoringService({
    getOwnerKey: () => ownerKey,
    resolveProfile: async (profileHandle) => ({
      profileHandle,
      displayName:
        profileHandle === "profile-a" ? "Research Profile" : "Other Profile",
      profilePath: profileHandle === "profile-a" ? profileA : profileB,
    }),
    listInstalledSkills:
      options.skills ??
      ((profileHandle) => [
        {
          name: "weekly-summary",
          category: "writing",
          description: "Draft the weekly summary",
          path: join(
            profileHandle === "profile-a" ? profileA : profileB,
            "skills",
            "writing",
            "weekly-summary",
          ),
        },
      ]),
    listMcpServers: options.servers ?? (async () => [mcpServer()]),
    discoverMcpTools: options.tools ?? (async () => []),
    now: () => now,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, "0")}`,
  });
}

function expectCode(
  action: () => unknown,
  code: string,
): CapabilityAuthoringServiceError {
  try {
    action();
    throw new Error("Expected capability authoring operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityAuthoringServiceError);
    expect(error).toMatchObject({ code });
    return error as CapabilityAuthoringServiceError;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-capability-authoring-"));
  profileA = join(root, "profiles", "profile-a");
  profileB = join(root, "profiles", "profile-b");
  mkdirSync(join(profileA, "skills"), { recursive: true });
  mkdirSync(join(profileB, "skills"), { recursive: true });
  writeSkill(profileA, "writing", "weekly-summary", {
    description: "Draft the weekly summary",
    files: { "references/checklist.md": "# Checklist\noriginal\n" },
  });
  writeSkill(profileB, "writing", "weekly-summary");
  ownerKey = "owner-a";
  now = new Date("2026-08-06T00:00:00.000Z");
  uuidIndex = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("CapabilityAuthoringService", () => {
  // @lat: [[agentera-agent-control-plane#Installed capability authoring boundary]]
  it("lists only renderer-safe Profile, Skill, MCP, and discovered-tool metadata", async () => {
    const summary = await service().listAuthoringCapabilities("profile-a");

    expect(summary).toEqual({
      profile: {
        profileHandle: "profile-a",
        displayName: "Research Profile",
      },
      skills: [
        {
          name: "weekly-summary",
          category: "writing",
          description: "Draft the weekly summary",
        },
      ],
      mcpServers: [
        {
          logicalName: "private-docs",
          enabled: true,
          tools: [
            { name: "docs.read", description: "Read approved documents" },
            {
              name: "docs.search",
              description: "Search approved documents",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(profileA);
    expect(serialized).not.toContain("author.internal.example.test");
    expect(serialized).not.toContain("author-secret");
    expect(serialized).not.toMatch(
      /"(?:path|url|command|args|env|auth|token|headers)"\s*:/i,
    );
  });

  it("keeps a flat Hermes Skill that has no category directory", async () => {
    const flatSkill = writeSkill(profileA, "", "research", {
      description: "Local research workflow",
    });
    const authoring = service({
      skills: () => [
        {
          name: "research",
          category: "",
          description: "Local research workflow",
          path: flatSkill,
        },
      ],
    });

    const summary = await authoring.listAuthoringCapabilities("profile-a");

    expect(summary.skills).toEqual([
      {
        name: "research",
        category: "",
        description: "Local research workflow",
      },
    ]);
    expect(
      authoring.prepareInstalledSkillSnapshot({
        profileId: "profile-a",
        skillName: "research",
      }),
    ).toMatchObject({
      profileHandle: "profile-a",
      skillName: "research",
      category: "",
      fileCount: 1,
    });
  });

  it("keeps the current capability inventory during a same-owner context notification", async () => {
    const authoring = service();
    await authoring.listAuthoringCapabilities("profile-a");

    authoring.notifyContextChanged();

    expect(
      authoring.prepareInstalledSkillSnapshot({
        profileId: "profile-a",
        skillName: "weekly-summary",
      }),
    ).toMatchObject({
      profileHandle: "profile-a",
      skillName: "weekly-summary",
      fileCount: 2,
    });
  });

  it("prepares an immutable Skill snapshot and consumes its handle once", async () => {
    const authoring = service();
    await authoring.listAuthoringCapabilities("profile-a");
    const preview = authoring.prepareInstalledSkillSnapshot({
      profileId: "profile-a",
      skillName: "weekly-summary",
    });

    expect(preview).toMatchObject({
      snapshotHandle: expect.any(String),
      profileHandle: "profile-a",
      skillName: "weekly-summary",
      category: "writing",
      description: "Draft the weekly summary",
      fileCount: 2,
      findings: [],
    });
    expect(preview.files).toEqual([
      expect.objectContaining({
        draftLocation: "skills/weekly-summary/SKILL.md",
        mediaType: "text/markdown",
      }),
      expect.objectContaining({
        draftLocation: "skills/weekly-summary/references/checklist.md",
        mediaType: "text/markdown",
      }),
    ]);
    expect(JSON.stringify(preview)).not.toContain(profileA);

    writeFileSync(
      join(
        profileA,
        "skills",
        "writing",
        "weekly-summary",
        "references",
        "checklist.md",
      ),
      "# Checklist\nmutated after prepare\n",
    );
    const assets = authoring.confirmInstalledSkillSnapshot({
      snapshotHandle: preview.snapshotHandle,
      confirmation: "copy-selected-skill-to-draft",
    });
    expect(assets).toContainEqual({
      path: "skills/weekly-summary/references/checklist.md",
      content: "# Checklist\noriginal\n",
    });
    expectCode(
      () =>
        authoring.confirmInstalledSkillSnapshot({
          snapshotHandle: preview.snapshotHandle,
          confirmation: "copy-selected-skill-to-draft",
        }),
      "capability_handle_invalid",
    );
  });

  it("rejects path escape, symlinks, invalid UTF-8, hidden/cache files, duplicate normalized paths, and local DLP findings", async () => {
    const outside = writeSkill(profileB, "outside", "outside-skill");
    const cases: Array<{ name: string; skillPath: () => string }> = [
      { name: "path escape", skillPath: () => outside },
      {
        name: "symlink",
        skillPath: () => {
          const skillPath = writeSkill(profileA, "unsafe", "symlinked");
          symlinkSync(
            join(profileA, "skills", "writing", "weekly-summary", "SKILL.md"),
            join(skillPath, "linked.md"),
          );
          return skillPath;
        },
      },
      {
        name: "invalid UTF-8",
        skillPath: () =>
          writeSkill(profileA, "unsafe", "invalid-utf8", {
            files: { "binary.txt": Buffer.from([0xc3, 0x28]) },
          }),
      },
      {
        name: "hidden file",
        skillPath: () =>
          writeSkill(profileA, "unsafe", "hidden", {
            files: { ".secret": "hidden\n" },
          }),
      },
      {
        name: "cache directory",
        skillPath: () =>
          writeSkill(profileA, "unsafe", "cached", {
            files: { "node_modules/cache.txt": "cache\n" },
          }),
      },
      {
        name: "DLP",
        skillPath: () =>
          writeSkill(profileA, "unsafe", "dlp", {
            files: {
              "secret.txt":
                "OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value\n",
            },
          }),
      },
    ];

    for (const entry of cases) {
      const skillPath = entry.skillPath();
      const authoring = service({
        skills: () => [
          {
            name: "selected-skill",
            category: "unsafe",
            description: entry.name,
            path: skillPath,
          },
        ],
      });
      await authoring.listAuthoringCapabilities("profile-a");
      const error = expectCode(
        () =>
          authoring.prepareInstalledSkillSnapshot({
            profileId: "profile-a",
            skillName: "selected-skill",
          }),
        entry.name === "DLP"
          ? "capability_dlp_blocked"
          : "capability_source_unsafe",
      );
      if (entry.name === "DLP") {
        expect(error).toMatchObject({
          findings: expect.arrayContaining([
            {
              code: "credential_api_key",
              path: "skills/selected-skill/secret.txt",
              line: 1,
            },
          ]),
        });
      }
    }

    const duplicateOne = writeSkill(profileA, "unsafe", "duplicate-one");
    const duplicateTwo = writeSkill(profileA, "unsafe", "duplicate-two");
    const duplicateAuthoring = service({
      skills: () => [
        {
          name: "selected-skill",
          category: "one",
          description: "First source",
          path: duplicateOne,
        },
        {
          name: "selected-skill",
          category: "two",
          description: "Second source",
          path: duplicateTwo,
        },
      ],
    });
    await duplicateAuthoring.listAuthoringCapabilities("profile-a");
    expectCode(
      () =>
        duplicateAuthoring.prepareInstalledSkillSnapshot({
          profileId: "profile-a",
          skillName: "selected-skill",
        }),
      "capability_source_unsafe",
    );
  });

  it("expires handles and invalidates them after owner or selected-Profile changes", async () => {
    const authoring = service();
    await authoring.listAuthoringCapabilities("profile-a");
    const expired = authoring.prepareInstalledSkillSnapshot({
      profileId: "profile-a",
      skillName: "weekly-summary",
    });
    now = new Date("2026-08-06T00:11:00.000Z");
    expectCode(
      () =>
        authoring.confirmInstalledSkillSnapshot({
          snapshotHandle: expired.snapshotHandle,
          confirmation: "copy-selected-skill-to-draft",
        }),
      "capability_handle_expired",
    );

    now = new Date("2026-08-06T00:00:00.000Z");
    const ownerBound = authoring.prepareInstalledSkillSnapshot({
      profileId: "profile-a",
      skillName: "weekly-summary",
    });
    ownerKey = "owner-b";
    expectCode(
      () =>
        authoring.confirmInstalledSkillSnapshot({
          snapshotHandle: ownerBound.snapshotHandle,
          confirmation: "copy-selected-skill-to-draft",
        }),
      "capability_handle_invalid",
    );

    ownerKey = "owner-a";
    await authoring.listAuthoringCapabilities("profile-a");
    const profileBound = authoring.prepareInstalledSkillSnapshot({
      profileId: "profile-a",
      skillName: "weekly-summary",
    });
    await authoring.listAuthoringCapabilities("profile-b");
    expectCode(
      () =>
        authoring.confirmInstalledSkillSnapshot({
          snapshotHandle: profileBound.snapshotHandle,
          confirmation: "copy-selected-skill-to-draft",
        }),
      "capability_handle_invalid",
    );
  });

  it("prepares and confirms only selected logical MCP metadata", async () => {
    const authoring = service();
    await authoring.listAuthoringCapabilities("profile-a");
    const preview = authoring.prepareMcpRequirement({
      profileId: "profile-a",
      logicalName: "private-docs",
      tools: ["docs.search", "docs.read"],
      required: true,
      permissionReason: "Search the employee-selected document set",
    });
    expect(preview).toEqual({
      requirementHandle: expect.any(String),
      profileHandle: "profile-a",
      logicalName: "private-docs",
      tools: [
        { name: "docs.read", description: "Read approved documents" },
        { name: "docs.search", description: "Search approved documents" },
      ],
      required: true,
      permissionReason: "Search the employee-selected document set",
      expiresAt: "2026-08-06T00:10:00.000Z",
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /author\.internal|author-secret|"(?:url|command|args|env|auth|token|headers)"\s*:/i,
    );
    expect(
      authoring.confirmMcpRequirement({
        requirementHandle: preview.requirementHandle,
        confirmation: "add-logical-mcp-requirement",
      }),
    ).toEqual({
      logicalName: "private-docs",
      tools: ["docs.read", "docs.search"],
      required: true,
      permissionReason: "Search the employee-selected document set",
    });
    expectCode(
      () =>
        authoring.confirmMcpRequirement({
          requirementHandle: preview.requirementHandle,
          confirmation: "add-logical-mcp-requirement",
        }),
      "capability_handle_invalid",
    );

    for (const input of [
      {
        profileId: "profile-a",
        logicalName: "private-docs",
        tools: ["docs.delete"],
        required: true,
        permissionReason: "Delete documents",
      },
      {
        profileId: "profile-a",
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason:
          "OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value",
      },
    ]) {
      expectCode(
        () => authoring.prepareMcpRequirement(input),
        "capability_requirement_invalid",
      );
    }
  });
});
