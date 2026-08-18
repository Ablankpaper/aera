// @vitest-environment node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../../shared/agentera-agent-control";
import type { AgentVersion } from "./client";
import {
  configureHermesProjectionMutationPort,
  HermesProjectionError,
  HermesProjectionManager,
} from "./hermes-projection";
import { canonicalizeEditableAgent } from "./manifest";
import type { ManagedModelMutationPort } from "../model-configuration-mutation-port";
import {
  clearManagedModelFileRoots,
  ModelConfigurationWriteAuthority,
  registerManagedModelFileRoots,
} from "../model-configuration-write-authority";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const STAGING_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_2_ID = "55555555-5555-4555-8555-555555555555";
const PROFILE_ID = "hermes-profile";

function executingModelMutationPort(): ManagedModelMutationPort {
  const authority = new ModelConfigurationWriteAuthority();
  return {
    async mutate(input) {
      return authority.run(
        {
          globalCatalog: input.globalCatalog,
          profileIds: input.profileIds,
        },
        async (permit) => {
          const plan = await input.prepare();
          const value = await plan.write(permit);
          return {
            status: "executed" as const,
            value,
            catalog: {
              revision: "0".repeat(64),
              targetProfileId: input.profileIds[0],
              routes: [],
            },
          };
        },
      );
    },
  };
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeTreeWritable(join(path, name));
}

function manifest(): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt: "Use the published base safely." },
    assets: [
      {
        path: "skills/research/SKILL.md",
        kind: "skill",
        mediaType: "text/markdown",
      },
      {
        path: "knowledge/brief.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
      {
        path: "skills/research/references/checklist.md",
        kind: "skill",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
}

function assets(): AgentDraftAssetInput[] {
  return [
    {
      path: "skills/research/SKILL.md",
      content:
        "---\nname: research\ndescription: Original description\n---\n\n# Research\n\nSigned instructions.\n",
    },
    { path: "knowledge/brief.md", content: "# Brief\n" },
    {
      path: "skills/research/references/checklist.md",
      content: "# Checklist\n",
    },
  ];
}

function version(versionNumber = 1, versionId = VERSION_ID): AgentVersion {
  const canonical = canonicalizeEditableAgent(manifest(), assets());
  return {
    id: versionId,
    definition_id: DEFINITION_ID,
    version_number: versionNumber,
    manifest: JSON.parse(
      canonical.manifestBytes.toString("utf8"),
    ) as AgentVersion["manifest"],
    bundle: JSON.parse(
      canonical.bundleBytes.toString("utf8"),
    ) as AgentVersion["bundle"],
    content_digest: canonical.contentDigest,
    signing_key_id: "projection-test-key",
    signature: "A".repeat(86),
    runtime_minimum_version: "v0.18.2-agentera.1",
    runtime_maximum_version_exclusive: "v0.19.0",
    published_at: "2026-07-19T18:30:00.000Z",
  };
}

describe("deterministic read-only Hermes Agent projection", () => {
  let root = "";
  let userDataPath = "";
  let profilePath = "";
  let manager: HermesProjectionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-hermes-projection-"));
    userDataPath = join(root, "user-data");
    profilePath = join(root, PROFILE_ID);
    mkdirSync(userDataPath, { recursive: true });
    mkdirSync(profilePath, { recursive: true });
    registerManagedModelFileRoots({
      globalRoot: join(root, "hermes-home"),
      profiles: { [PROFILE_ID]: profilePath },
    });
    manager = new HermesProjectionManager({
      userDataPath,
      randomUUID: () => STAGING_ID,
    });
    configureHermesProjectionMutationPort(executingModelMutationPort());
  });

  afterEach(() => {
    configureHermesProjectionMutationPort(null);
    clearManagedModelFileRoots();
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("materializes reproducible versioned assets and patches only external_dirs", async () => {
    const config = [
      "# formatting and private settings stay byte-identical",
      "model:",
      '  default: "gpt-5.6"',
      "credentials:",
      "  local_token: keep-local",
      "skills:",
      "  disabled:",
      "    - private-local-skill",
      "tools:",
      "  allowed: []",
      "",
    ].join("\n");
    writeFileSync(join(profilePath, "config.yaml"), config);
    writeFileSync(join(profilePath, "MEMORY.md"), "private memory\n");
    writeFileSync(join(profilePath, "USER.md"), "private user\n");

    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    const activated = await manager.activateForProfile({
      projection: built,
      profileId: PROFILE_ID,
      profilePath,
    });

    const expectedVersionRoot = join(
      userDataPath,
      "agentera-control-plane",
      "projections",
      AGENT_INSTALLATION_ID,
      "versions",
      VERSION_ID,
      built.contentDigest,
    );
    expect(built.versionRoot).toBe(expectedVersionRoot);
    expect(built.skills).toEqual([
      {
        originalName: "research",
        scopedName: "agentera.11111111.v1.research",
      },
    ]);
    expect(
      readFileSync(
        join(expectedVersionRoot, "assets", "knowledge", "brief.md"),
        "utf8",
      ),
    ).toBe("# Brief\n");
    const wrapper = readFileSync(
      join(
        expectedVersionRoot,
        "skills",
        "agentera.11111111.v1.research",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(wrapper).toContain("name: agentera.11111111.v1.research");
    expect(wrapper).toContain("original_name: research");
    expect(wrapper).toContain(`source_digest: ${built.contentDigest}`);
    expect(wrapper).toContain("Signed instructions.");
    expect(
      readFileSync(
        join(
          expectedVersionRoot,
          "skills",
          "agentera.11111111.v1.research",
          "references",
          "checklist.md",
        ),
        "utf8",
      ),
    ).toBe("# Checklist\n");
    expect(activated.diagnostics).toEqual([
      {
        originalName: "research",
        scopedName: "agentera.11111111.v1.research",
        origin: "published",
      },
    ]);
    expect(statSync(activated.externalSkillsDirectory).mode & 0o222).toBe(0);
    expect(
      statSync(
        join(
          activated.externalSkillsDirectory,
          "agentera.11111111.v1.research",
          "SKILL.md",
        ),
      ).mode & 0o222,
    ).toBe(0);
    expect(
      readFileSync(
        join(
          activated.externalSkillsDirectory,
          "agentera.11111111.v1.research",
          "references",
          "checklist.md",
        ),
        "utf8",
      ),
    ).toBe("# Checklist\n");

    const expectedConfig = config.replace(
      "tools:\n",
      `  external_dirs:\n    - ${JSON.stringify(
        activated.externalSkillsDirectory,
      )}\ntools:\n`,
    );
    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      expectedConfig,
    );
    expect(readFileSync(join(profilePath, "MEMORY.md"), "utf8")).toBe(
      "private memory\n",
    );
    expect(readFileSync(join(profilePath, "USER.md"), "utf8")).toBe(
      "private user\n",
    );

    await manager.activateForProfile({
      projection: built,
      profileId: PROFILE_ID,
      profilePath,
    });
    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      expectedConfig,
    );
  });

  it("keeps an Organization version projection outside the writable Profile and preserves private learning bytes", async () => {
    writeFileSync(join(profilePath, "config.yaml"), "tools:\n  allowed: []\n");
    writeFileSync(join(profilePath, "MEMORY.md"), "private memory\n");
    writeFileSync(join(profilePath, "USER.md"), "private user\n");
    mkdirSync(join(profilePath, "skills", "local-only"), { recursive: true });
    mkdirSync(join(profilePath, "sessions"), { recursive: true });
    mkdirSync(join(profilePath, ".curator"), { recursive: true });
    const privateFiles = [
      ["MEMORY.md", "private memory\n"],
      ["USER.md", "private user\n"],
      ["skills/local-only/SKILL.md", "local-only learned skill\n"],
      ["sessions/completed.json", '{"completed":true}\n'],
      [".curator/state.json", '{"private":true}\n'],
    ] as const;
    for (const [path, content] of privateFiles.slice(2)) {
      writeFileSync(join(profilePath, path), content);
    }

    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    const activated = await manager.activateForProfile({
      projection: built,
      profileId: PROFILE_ID,
      profilePath,
    });

    expect(relative(profilePath, built.versionRoot).startsWith("..")).toBe(
      true,
    );
    expect(
      relative(profilePath, activated.externalSkillsDirectory).startsWith(".."),
    ).toBe(true);
    expect(statSync(built.versionRoot).mode & 0o222).toBe(0);
    expect(statSync(activated.externalSkillsDirectory).mode & 0o222).toBe(0);
    for (const [path, content] of privateFiles) {
      expect(readFileSync(join(profilePath, path), "utf8")).toBe(content);
    }
  });

  it("lets a same-name Profile-local Skill win without changing it", async () => {
    const localSkill = join(
      profilePath,
      "skills",
      "team",
      "local-research",
      "SKILL.md",
    );
    mkdirSync(join(profilePath, "skills", "team", "local-research"), {
      recursive: true,
    });
    writeFileSync(localSkill, "---\nname: research\n---\nlocal learning\n");
    const before = readFileSync(localSkill);
    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });

    const activated = await manager.activateForProfile({
      projection: built,
      profileId: PROFILE_ID,
      profilePath,
    });

    expect(activated.diagnostics).toEqual([
      {
        originalName: "research",
        scopedName: "agentera.11111111.v1.research",
        origin: "local_override",
      },
    ]);
    expect(readdirSync(activated.externalSkillsDirectory)).toEqual([]);
    expect(readFileSync(localSkill)).toEqual(before);
  });

  it("appends to an existing YAML sequence without reformatting prior entries", async () => {
    const existingExternal = join(root, "existing-external-skills");
    mkdirSync(existingExternal);
    const config = [
      "skills:",
      "  external_dirs:",
      "    # existing order and comment are preserved",
      `    - ${JSON.stringify(existingExternal)}`,
      "  disabled: []",
      "provider: auto",
      "",
    ].join("\n");
    writeFileSync(join(profilePath, "config.yaml"), config);
    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });

    const activated = await manager.activateForProfile({
      projection: built,
      profileId: PROFILE_ID,
      profilePath,
    });

    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      config.replace(
        "  disabled: []\n",
        `    - ${JSON.stringify(
          activated.externalSkillsDirectory,
        )}\n  disabled: []\n`,
      ),
    );
  });

  it("switches the stable active projection while retaining the prior version", async () => {
    const first = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    await manager.activateForProfile({
      projection: first,
      profileId: PROFILE_ID,
      profilePath,
    });
    const configAfterFirst = readFileSync(
      join(profilePath, "config.yaml"),
      "utf8",
    );

    const second = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(2, VERSION_2_ID),
    });
    await manager.activateForProfile({
      projection: second,
      profileId: PROFILE_ID,
      profilePath,
    });

    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      configAfterFirst,
    );
    expect(readdirSync(second.externalSkillsDirectory)).toEqual([
      "agentera.11111111.v2.research",
    ]);
    expect(existsSync(first.versionRoot)).toBe(true);
    expect(existsSync(second.versionRoot)).toBe(true);
  });

  it("rolls back generated activation when the allowlisted config write fails", async () => {
    const configPath = join(profilePath, "config.yaml");
    const config = "provider: auto\n";
    writeFileSync(configPath, config);
    const failing = new HermesProjectionManager({
      userDataPath,
      randomUUID: () => STAGING_ID,
      writeConfig: () => {
        throw new Error("simulated config write failure");
      },
    });
    const built = failing.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });

    await expect(
      failing.activateForProfile({
        projection: built,
        profileId: PROFILE_ID,
        profilePath,
      }),
    ).rejects.toThrow(/config write failure/);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(existsSync(built.externalSkillsDirectory)).toBe(false);
  });

  // @lat: [[beta27-reliability-plan#Recoverable model configuration#Hermes projection config activation is transactional]]
  it("does not activate or write config when model recovery refuses the projection", async () => {
    const configPath = join(profilePath, "config.yaml");
    const config = "provider: auto\n";
    writeFileSync(configPath, config);
    const mutate = vi.fn(async () => ({
      status: "rejected" as const,
      stage: "recovery" as const,
      code: "model_configuration_recovery_required" as const,
      rollback: "recovery_required" as const,
      diagnosticId: "0123456789ab",
    }));
    const blocked = new HermesProjectionManager({
      userDataPath,
      randomUUID: () => STAGING_ID,
      modelMutationPort: { mutate } as unknown as ManagedModelMutationPort,
    });
    const built = blocked.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });

    await expect(
      blocked.activateForProfile({
        projection: built,
        profileId: "hermes-profile",
        profilePath,
      }),
    ).rejects.toMatchObject({
      code: "model_configuration_recovery_required",
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(existsSync(built.externalSkillsDirectory)).toBe(false);
  });

  it.each([
    "skills:\n  external_dirs: &shared\n    - /tmp/shared\n",
    "shared: &shared\n  - /tmp/shared\nskills:\n  external_dirs: *shared\n",
    "skills:\n  external_dirs: !private\n    - /tmp/shared\n",
    "defaults: &defaults\n  external_dirs:\n    - /tmp/shared\nskills:\n  <<: *defaults\n",
  ])("rejects aliases, anchors, and tags on external_dirs", async (config) => {
    const configPath = join(profilePath, "config.yaml");
    writeFileSync(configPath, config);
    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    await expect(
      manager.activateForProfile({
        projection: built,
        profileId: PROFILE_ID,
        profilePath,
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<HermesProjectionError>>({
        code: "unsafe_external_dirs",
      }),
    );
    expect(readFileSync(configPath, "utf8")).toBe(config);
  });
});
