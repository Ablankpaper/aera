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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../../shared/agentera-agent-control";
import type { AgentVersion } from "./client";
import {
  HermesProjectionError,
  HermesProjectionManager,
} from "./hermes-projection";
import { canonicalizeEditableAgent } from "./manifest";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const STAGING_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_2_ID = "55555555-5555-4555-8555-555555555555";

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
    profilePath = join(root, "hermes-profile");
    mkdirSync(userDataPath, { recursive: true });
    mkdirSync(profilePath, { recursive: true });
    manager = new HermesProjectionManager({
      userDataPath,
      randomUUID: () => STAGING_ID,
    });
  });

  afterEach(() => {
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("materializes reproducible versioned assets and patches only external_dirs", () => {
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
    const activated = manager.activateForProfile({
      projection: built,
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

    manager.activateForProfile({ projection: built, profilePath });
    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      expectedConfig,
    );
  });

  it("lets a same-name Profile-local Skill win without changing it", () => {
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

    const activated = manager.activateForProfile({
      projection: built,
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

  it("appends to an existing YAML sequence without reformatting prior entries", () => {
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

    const activated = manager.activateForProfile({
      projection: built,
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

  it("switches the stable active projection while retaining the prior version", () => {
    const first = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    manager.activateForProfile({ projection: first, profilePath });
    const configAfterFirst = readFileSync(
      join(profilePath, "config.yaml"),
      "utf8",
    );

    const second = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(2, VERSION_2_ID),
    });
    manager.activateForProfile({ projection: second, profilePath });

    expect(readFileSync(join(profilePath, "config.yaml"), "utf8")).toBe(
      configAfterFirst,
    );
    expect(readdirSync(second.externalSkillsDirectory)).toEqual([
      "agentera.11111111.v2.research",
    ]);
    expect(existsSync(first.versionRoot)).toBe(true);
    expect(existsSync(second.versionRoot)).toBe(true);
  });

  it("rolls back generated activation when the allowlisted config write fails", () => {
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

    expect(() =>
      failing.activateForProfile({ projection: built, profilePath }),
    ).toThrow(/config write failure/);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(existsSync(built.externalSkillsDirectory)).toBe(false);
  });

  it.each([
    "skills:\n  external_dirs: &shared\n    - /tmp/shared\n",
    "shared: &shared\n  - /tmp/shared\nskills:\n  external_dirs: *shared\n",
    "skills:\n  external_dirs: !private\n    - /tmp/shared\n",
    "defaults: &defaults\n  external_dirs:\n    - /tmp/shared\nskills:\n  <<: *defaults\n",
  ])("rejects aliases, anchors, and tags on external_dirs", (config) => {
    const configPath = join(profilePath, "config.yaml");
    writeFileSync(configPath, config);
    const built = manager.materializeVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: version(),
    });
    expect(() =>
      manager.activateForProfile({ projection: built, profilePath }),
    ).toThrowError(
      expect.objectContaining<Partial<HermesProjectionError>>({
        code: "unsafe_external_dirs",
      }),
    );
    expect(readFileSync(configPath, "utf8")).toBe(config);
  });
});
