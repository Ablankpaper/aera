// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
  OfficialManagedUpdate,
} from "../../shared/agentera-agent-control";
import type { SecureStorageAdapter } from "../agentera-auth/store";
import {
  AgenteraProfileBindingStore,
  type AgenteraRuntimeOwner,
} from "../agentera-profile-binding";
import type {
  AgentInstallation,
  AgentInstallationCreation,
  AgentPolicySnapshot,
  AgentVersion,
  CreateAgentInstallationRequest,
} from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import type {
  ActivatedHermesProjection,
  HermesVersionProjection,
} from "./hermes-projection";
import {
  AgentInstallationManager,
  type AgentInstallationClient,
  type AgentInstallationProfileAdapter,
  type AgentInstallationProjection,
  type AgentInstallationTrust,
  type AgentInstallationVersionCache,
} from "./installation-manager";
import { canonicalizeEditableAgent } from "./manifest";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const RUNTIME_PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_2_ID = "77777777-7777-4777-8777-777777777777";
const POLICY_2_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POLICY_3_ID = "15151515-1515-4515-8515-151515151515";
const NOW = new Date("2026-07-19T19:30:00.000Z");
const ORIGIN = "http://127.0.0.1:8086";
const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORGANIZATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OFFICIAL_RELEASE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OFFICIAL_RELEASE_REVISION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OFFICIAL_RELEASE_REVISION_2_ID = "13131313-1313-4313-8313-131313131313";
const OFFICIAL_RELEASE_REVISION_3_ID = "14141414-1414-4414-8414-141414141414";
const PLATFORM_ID = "12121212-1212-4212-8212-121212121212";
const BACKUP_ID = "16161616-1616-4616-8616-161616161616";
const SOURCE_INSTALLATION_ID = "17171717-1717-4717-8717-171717171717";
const PROFILE_LINEAGE_ID = "18181818-1818-4818-8818-181818181818";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, "utf8");
  }
  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^protected:/, "");
  }
}

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function manifest(): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt: "Installed published base." },
    assets: [
      {
        path: "knowledge/base.md",
        kind: "knowledge",
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
  return [{ path: "knowledge/base.md", content: "# Base\n" }];
}

function makeVersion(id = VERSION_ID, number = 1): AgentVersion {
  const canonical = canonicalizeEditableAgent(manifest(), assets());
  return {
    id,
    definition_id: DEFINITION_ID,
    version_number: number,
    manifest: JSON.parse(
      canonical.manifestBytes.toString("utf8"),
    ) as AgentVersion["manifest"],
    bundle: JSON.parse(
      canonical.bundleBytes.toString("utf8"),
    ) as AgentVersion["bundle"],
    content_digest: canonical.contentDigest,
    signing_key_id: "installation-test-key",
    signature: "A".repeat(86),
    runtime_minimum_version: "v0.18.2-agentera.1",
    runtime_maximum_version_exclusive: "v0.19.0",
    published_at: NOW.toISOString(),
  };
}

function makePolicy(
  version: AgentVersion,
  id = POLICY_ID,
): AgentPolicySnapshot {
  return {
    id,
    installation_id: AGENT_INSTALLATION_ID,
    agent_version_id: version.id,
    issuer: ORIGIN,
    policy_version: 1,
    document: {
      schema_version: 1,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: version.id,
      version_digest: version.content_digest,
      model_constraints: version.manifest.model_constraints,
      runtime_compatibility: version.manifest.runtime_compatibility,
      tools: version.manifest.tools,
      deny_rules: [],
      publication_allowed: false,
    },
    content_digest: "ab".repeat(32),
    signing_key_id: "installation-policy-test-key",
    signature: "B".repeat(86),
    created_at: NOW.toISOString(),
  };
}

function pendingInstallation(versionId = VERSION_ID): AgentInstallation {
  return {
    id: AGENT_INSTALLATION_ID,
    definition_id: DEFINITION_ID,
    selected_version_id: versionId,
    policy_snapshot_id: POLICY_ID,
    status: "pending",
    update_policy: "manual",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function pendingOfficialInstallation(
  status: "pending" | "active" = "pending",
  overrides: {
    versionId?: string;
    policyId?: string;
    releaseRevisionId?: string;
  } = {},
): AgentInstallation {
  return {
    id: AGENT_INSTALLATION_ID,
    definition_id: DEFINITION_ID,
    selected_version_id: overrides.versionId ?? VERSION_ID,
    policy_snapshot_id: overrides.policyId ?? POLICY_ID,
    official_release_id: OFFICIAL_RELEASE_ID,
    selected_release_revision_id:
      overrides.releaseRevisionId ?? OFFICIAL_RELEASE_REVISION_ID,
    status,
    update_policy: "managed",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...(status === "active"
      ? {
          runtime_profile_id: RUNTIME_PROFILE_ID,
          activated_at: NOW.toISOString(),
        }
      : {}),
  };
}

function makeOfficialPolicy(
  version: AgentVersion,
  releaseRevisionId = OFFICIAL_RELEASE_REVISION_ID,
  policyId = POLICY_ID,
): AgentPolicySnapshot {
  const value = makePolicy(version, policyId);
  return {
    ...value,
    document: {
      ...value.document,
      official_context: {
        platform_id: PLATFORM_ID,
        release_id: OFFICIAL_RELEASE_ID,
        release_revision_id: releaseRevisionId,
        user_id: owner.ownerId,
        device_installation_id: owner.deviceInstallationId,
        installation_id: AGENT_INSTALLATION_ID,
        product_scope: "USER",
        product_context_id: owner.tenantId,
      },
    },
  };
}

function officialDetail(
  version: AgentVersion,
  releaseRevisionId: string,
): Awaited<ReturnType<AgentInstallationClient["getOfficialAgent"]>> {
  return {
    agent: {
      definitionId: DEFINITION_ID,
      displayName: "Official Research Agent",
      iconMediaType: null,
      iconDataBase64Url: null,
      versionId: version.id,
      versionNumber: version.version_number,
      releaseId: OFFICIAL_RELEASE_ID,
      releaseRevisionId,
      channel: "stable",
      runtimeMinimumVersion: version.runtime_minimum_version,
      runtimeMaximumVersionExclusive:
        version.runtime_maximum_version_exclusive ?? null,
      installationState: "installed",
      updateState: "update_available",
    },
    version,
  };
}

const owner: AgenteraRuntimeOwner = {
  tenantId: "88888888-8888-4888-8888-888888888888",
  ownerId: "99999999-9999-4999-8999-999999999999",
  deviceInstallationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("Agent installation orchestration", () => {
  let root = "";
  let userDataPath = "";
  let profilesRoot = "";
  let freshProfilePath = "";
  let database: AgenteraControlPlaneDatabase;
  let bindings: AgenteraProfileBindingStore;
  let client: AgentInstallationClient;
  let trust: AgentInstallationTrust;
  let cache: AgentInstallationVersionCache;
  let projection: AgentInstallationProjection;
  let profiles: AgentInstallationProfileAdapter;
  let createInstallation: Mock<AgentInstallationClient["createInstallation"]>;
  let getVersion: Mock<AgentInstallationClient["getVersion"]>;
  let getOfficialAgent: Mock<AgentInstallationClient["getOfficialAgent"]>;
  let getPolicySnapshot: Mock<AgentInstallationClient["getPolicySnapshot"]>;
  let activateInstallation: Mock<
    AgentInstallationClient["activateInstallation"]
  >;
  let selectInstallationVersion: Mock<
    AgentInstallationClient["selectInstallationVersion"]
  >;
  let archiveInstallation: Mock<AgentInstallationClient["archiveInstallation"]>;
  let getManagedUpdate: Mock<AgentInstallationClient["getManagedUpdate"]>;
  let applyManagedUpdate: Mock<AgentInstallationClient["applyManagedUpdate"]>;
  let materializeVersion: Mock<
    AgentInstallationProjection["materializeVersion"]
  >;
  let activateForProfile: Mock<
    AgentInstallationProjection["activateForProfile"]
  >;
  let createProfile: Mock<AgentInstallationProfileAdapter["createProfile"]>;
  let deleteProfile: Mock<
    NonNullable<AgentInstallationProfileAdapter["deleteProfile"]>
  >;
  let events: string[];
  let v1: AgentVersion;
  let policy: AgentPolicySnapshot;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-installation-manager-"));
    userDataPath = join(root, "user-data");
    profilesRoot = join(root, "profiles");
    freshProfilePath = join(profilesRoot, "fresh-agent");
    mkdirSync(profilesRoot, { recursive: true });
    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => RUNTIME_PROFILE_ID,
    });
    events = [];
    v1 = makeVersion();
    policy = makePolicy(v1);
    const creation: AgentInstallationCreation = {
      installation: pendingInstallation(),
      policy_snapshot: policy,
      replayed: false,
    };
    createInstallation = vi
      .fn<AgentInstallationClient["createInstallation"]>()
      .mockImplementation(async () => {
        events.push("cloud:create-pending");
        return creation;
      });
    getVersion = vi
      .fn<AgentInstallationClient["getVersion"]>()
      .mockImplementation(async () => {
        const row = database.sqlite
          .prepare(
            "SELECT status FROM local_agent_installations WHERE agent_installation_id = ?",
          )
          .get(AGENT_INSTALLATION_ID) as { status: string } | undefined;
        expect(row?.status).toBe("pending");
        events.push("cloud:get-version");
        return v1;
      });
    getOfficialAgent = vi
      .fn<AgentInstallationClient["getOfficialAgent"]>()
      .mockRejectedValue(new Error("official detail unavailable"));
    getPolicySnapshot = vi
      .fn<AgentInstallationClient["getPolicySnapshot"]>()
      .mockResolvedValue(policy);
    activateInstallation = vi
      .fn<AgentInstallationClient["activateInstallation"]>()
      .mockImplementation(async (_id, runtimeProfileId) => {
        events.push("cloud:activate");
        return {
          ...pendingInstallation(),
          runtime_profile_id: runtimeProfileId,
          status: "active",
          activated_at: NOW.toISOString(),
        };
      });
    selectInstallationVersion = vi
      .fn<AgentInstallationClient["selectInstallationVersion"]>()
      .mockImplementation(async (_id, versionId) => {
        events.push("cloud:select-version");
        return {
          ...pendingInstallation(versionId),
          runtime_profile_id: RUNTIME_PROFILE_ID,
          status: "active",
          activated_at: NOW.toISOString(),
        };
      });
    archiveInstallation = vi
      .fn<AgentInstallationClient["archiveInstallation"]>()
      .mockImplementation(async () => {
        events.push("cloud:archive");
        return {
          ...pendingInstallation(),
          runtime_profile_id: RUNTIME_PROFILE_ID,
          status: "archived",
          activated_at: NOW.toISOString(),
          archived_at: NOW.toISOString(),
        };
      });
    getManagedUpdate = vi
      .fn<AgentInstallationClient["getManagedUpdate"]>()
      .mockResolvedValue(null);
    applyManagedUpdate = vi.fn<AgentInstallationClient["applyManagedUpdate"]>();
    client = {
      origin: ORIGIN,
      createInstallation,
      getVersion,
      getOfficialAgent,
      getPolicySnapshot,
      activateInstallation,
      selectInstallationVersion,
      archiveInstallation,
      getManagedUpdate,
      applyManagedUpdate,
    };
    trust = {
      verifyPolicy: vi.fn(() => {
        events.push("verify:policy");
        return { contentDigest: policy.content_digest };
      }),
    };
    cache = {
      cacheVerifiedVersion: vi.fn((version) => {
        events.push("verify-cache:version");
        return version;
      }),
      getVerifiedVersion: vi.fn(() => v1),
      cacheVerifiedPolicySnapshot: vi.fn((_versionId, candidate) => candidate),
      getVerifiedPolicySnapshot: vi.fn(() => policy),
    };
    materializeVersion = vi
      .fn<AgentInstallationProjection["materializeVersion"]>()
      .mockImplementation(({ agentInstallationId, version }) => {
        events.push(`project:${version.id}`);
        return {
          agentInstallationId,
          definitionId: version.definition_id,
          versionId: version.id,
          versionNumber: version.version_number,
          contentDigest: version.content_digest,
          versionRoot: join(userDataPath, "projection", version.id),
          externalSkillsDirectory: join(
            userDataPath,
            "projection",
            "active",
            "skills",
          ),
          skills: [],
        } satisfies HermesVersionProjection;
      });
    activateForProfile = vi
      .fn<AgentInstallationProjection["activateForProfile"]>()
      .mockImplementation(({ projection }) => {
        events.push(`profile:project:${projection.versionId}`);
        return {
          externalSkillsDirectory: projection.externalSkillsDirectory,
          diagnostics: [],
        } satisfies ActivatedHermesProjection;
      });
    projection = { materializeVersion, activateForProfile };
    createProfile = vi
      .fn<AgentInstallationProfileAdapter["createProfile"]>()
      .mockImplementation((name, cloneFrom) => {
        events.push(`profile:create:${String(cloneFrom)}`);
        expect(name).toBe("Fresh Agent");
        mkdirSync(freshProfilePath, { recursive: true });
        return { success: true, id: "fresh-agent" };
      });
    deleteProfile = vi.fn((id: string) => {
      events.push(`profile:delete:${id}`);
      rmSync(freshProfilePath, { recursive: true, force: true });
      return { success: true };
    });
    profiles = {
      createProfile,
      deleteProfile,
      resolveProfilePath: (id) => {
        expect(id).toBe("fresh-agent");
        return freshProfilePath;
      },
      activateProfile: (id) => events.push(`profile:activate:${id}`),
    };
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function manager(ownerOverride = owner): AgentInstallationManager {
    return new AgentInstallationManager({
      database,
      client,
      trust,
      cache,
      projection,
      profileBindings: bindings,
      profiles,
      owner: ownerOverride,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => OPERATION_ID,
    });
  }

  async function installOfficialV1(): Promise<void> {
    policy = makeOfficialPolicy(v1);
    getPolicySnapshot.mockResolvedValue(policy);
    createInstallation.mockResolvedValueOnce({
      installation: pendingOfficialInstallation(),
      policy_snapshot: policy,
      replayed: false,
    });
    activateInstallation.mockResolvedValueOnce(
      pendingOfficialInstallation("active"),
    );
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: {
        scope: "PLATFORM",
        officialReleaseId: OFFICIAL_RELEASE_ID,
        selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
        updatePolicy: "managed",
      },
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
  }

  it("persists cloud pending before materialization and creates a non-cloned fresh Profile", async () => {
    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });

    expect(createInstallation).toHaveBeenCalledWith(
      {
        definition_id: DEFINITION_ID,
        version_id: VERSION_ID,
      } satisfies CreateAgentInstallationRequest,
      OPERATION_ID,
    );
    expect(createProfile).toHaveBeenCalledWith("Fresh Agent", null);
    expect(events).toEqual([
      "cloud:create-pending",
      "cloud:get-version",
      "verify-cache:version",
      "verify:policy",
      `project:${VERSION_ID}`,
      "profile:create:null",
      `profile:project:${VERSION_ID}`,
      "cloud:activate",
      "profile:activate:fresh-agent",
    ]);
    expect(installed).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      selectedVersionId: VERSION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
      retryCode: null,
    });
    expect(cache.cacheVerifiedPolicySnapshot).toHaveBeenCalledWith(
      VERSION_ID,
      policy,
    );
    expect(
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
  });

  it("verifies the model source owner and seeds only the fresh Profile before projection", async () => {
    const sourceProfilePath = join(profilesRoot, "source-profile");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "source-profile"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    const originalVerifyProfileBinding =
      bindings.verifyProfileBinding.bind(bindings);
    const verifyProfileBinding = vi
      .spyOn(bindings, "verifyProfileBinding")
      .mockImplementation((profilePath, requestedOwner) =>
        profilePath === sourceProfilePath
          ? {
              tenantId: requestedOwner.tenantId,
              ownerScope: "USER",
              ownerId: requestedOwner.ownerId,
              deviceInstallationId: requestedOwner.deviceInstallationId,
              agentInstallationId: null,
              runtimeProfileId: "19191919-1919-4919-8919-191919191919",
              boundAt: NOW.toISOString(),
            }
          : originalVerifyProfileBinding(profilePath, requestedOwner),
      );
    const configureFreshProfileModel = vi.fn(
      (input: {
        sourceProfileId: string;
        targetProfileId: string;
        version: AgentVersion;
      }) => {
        events.push(`profile:model:${input.targetProfileId}`);
      },
    );
    profiles.configureFreshProfileModel = configureFreshProfileModel;

    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: {
        kind: "fresh",
        name: "Fresh Agent",
        modelSourceProfileId: "source-profile",
      },
    });

    expect(verifyProfileBinding).toHaveBeenCalledWith(sourceProfilePath, owner);
    expect(configureFreshProfileModel).toHaveBeenCalledWith({
      sourceProfileId: "source-profile",
      targetProfileId: "fresh-agent",
      version: v1,
    });
    expect(events).toEqual([
      "cloud:create-pending",
      "cloud:get-version",
      "verify-cache:version",
      "verify:policy",
      `project:${VERSION_ID}`,
      "profile:create:null",
      "profile:model:fresh-agent",
      `profile:project:${VERSION_ID}`,
      "cloud:activate",
      "profile:activate:fresh-agent",
    ]);
  });

  // @lat: [[agentera-agent-control-plane#Cloud boundary#Platform identifier acceptance]]
  it("installs a version whose control-plane identifiers are UUIDv7", async () => {
    const definitionId = "0199e6c2-4b3e-7a91-8f2d-1c4b7e9a3d55";
    const versionId = "0199e6c2-4b3e-7c10-b0d4-2f8a5c1e6b77";
    const v7 = { ...makeVersion(versionId), definition_id: definitionId };
    const basePolicy = makePolicy(v7);
    const v7Policy = {
      ...basePolicy,
      document: { ...basePolicy.document, agent_definition_id: definitionId },
    };
    createInstallation.mockImplementationOnce(async () => {
      events.push("cloud:create-pending");
      return {
        installation: {
          ...pendingInstallation(versionId),
          definition_id: definitionId,
        },
        policy_snapshot: v7Policy,
        replayed: false,
      };
    });
    getVersion.mockImplementationOnce(async () => {
      events.push("cloud:get-version");
      return v7;
    });
    getPolicySnapshot.mockResolvedValue(v7Policy);
    activateInstallation.mockImplementationOnce(
      async (_id, runtimeProfileId) => {
        events.push("cloud:activate");
        return {
          ...pendingInstallation(versionId),
          definition_id: definitionId,
          runtime_profile_id: runtimeProfileId,
          policy_snapshot_id: v7Policy.id,
          status: "active",
          activated_at: NOW.toISOString(),
        };
      },
    );
    cache.getVerifiedVersion = vi.fn(() => v7);
    cache.getVerifiedPolicySnapshot = vi.fn(() => v7Policy);
    trust.verifyPolicy = vi.fn(() => {
      events.push("verify:policy");
      return { contentDigest: v7Policy.content_digest };
    });

    await expect(
      manager().install({
        definitionId,
        versionId,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("removes a fresh Profile and binding when signed model configuration fails", async () => {
    const sourceProfilePath = join(profilesRoot, "source-profile");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "source-profile"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    const originalVerifyProfileBinding =
      bindings.verifyProfileBinding.bind(bindings);
    vi.spyOn(bindings, "verifyProfileBinding").mockImplementation(
      (profilePath, requestedOwner) =>
        profilePath === sourceProfilePath
          ? {
              tenantId: requestedOwner.tenantId,
              ownerScope: "USER",
              ownerId: requestedOwner.ownerId,
              deviceInstallationId: requestedOwner.deviceInstallationId,
              agentInstallationId: null,
              runtimeProfileId: "19191919-1919-4919-8919-191919191919",
              boundAt: NOW.toISOString(),
            }
          : originalVerifyProfileBinding(profilePath, requestedOwner),
    );
    profiles.configureFreshProfileModel = vi.fn(() => {
      events.push("profile:model:failed");
      throw new Error(
        "The source Profile model is not allowed by the signed Agent version.",
      );
    });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: {
          kind: "fresh",
          name: "Fresh Agent",
          modelSourceProfileId: "source-profile",
        },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(deleteProfile).toHaveBeenCalledWith("fresh-agent");
    expect(existsSync(freshProfilePath)).toBe(false);
    expect(() =>
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toThrow();
    expect(events).not.toContain("profile:activate:fresh-agent");
    expect(
      database.sqlite
        .prepare(
          `SELECT status, retry_code, runtime_profile_id
           FROM local_agent_installations
           WHERE agent_installation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      status: "pending",
      retry_code: "profile_model_configuration_failed",
      runtime_profile_id: null,
    });
  });

  it("repairs an active installation model only from a verified current-owner Profile", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const sourceProfilePath = join(profilesRoot, "source-profile");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "source-profile"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    const originalVerifyProfileBinding =
      bindings.verifyProfileBinding.bind(bindings);
    vi.spyOn(bindings, "verifyProfileBinding").mockImplementation(
      (profilePath, requestedOwner) =>
        profilePath === sourceProfilePath
          ? {
              tenantId: requestedOwner.tenantId,
              ownerScope: "USER",
              ownerId: requestedOwner.ownerId,
              deviceInstallationId: requestedOwner.deviceInstallationId,
              agentInstallationId: null,
              runtimeProfileId: "19191919-1919-4919-8919-191919191919",
              boundAt: NOW.toISOString(),
            }
          : originalVerifyProfileBinding(profilePath, requestedOwner),
    );
    const configureFreshProfileModel = vi.fn();
    profiles.configureFreshProfileModel = configureFreshProfileModel;

    const repaired = await manager().repairInstallationModel({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profilePath: freshProfilePath,
      localProfileId: "fresh-agent",
      modelSourceProfileId: "source-profile",
    });

    expect(cache.getVerifiedVersion).toHaveBeenCalledWith(VERSION_ID);
    expect(configureFreshProfileModel).toHaveBeenCalledWith({
      sourceProfileId: "source-profile",
      targetProfileId: "fresh-agent",
      version: v1,
    });
    expect(repaired).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
      retryCode: null,
    });
    expect(client.selectInstallationVersion).not.toHaveBeenCalled();
    expect(client.activateInstallation).toHaveBeenCalledOnce();
  });

  it("fails closed when an active installation model source is not owned by the current account", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const sourceProfilePath = join(profilesRoot, "foreign-source");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "foreign-source"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    const originalVerifyProfileBinding =
      bindings.verifyProfileBinding.bind(bindings);
    vi.spyOn(bindings, "verifyProfileBinding").mockImplementation(
      (profilePath, requestedOwner) => {
        if (profilePath === sourceProfilePath) {
          throw new Error(
            "This Runtime Profile belongs to another Aera owner.",
          );
        }
        return originalVerifyProfileBinding(profilePath, requestedOwner);
      },
    );
    const configureFreshProfileModel = vi.fn();
    profiles.configureFreshProfileModel = configureFreshProfileModel;

    await expect(
      manager().repairInstallationModel({
        agentInstallationId: AGENT_INSTALLATION_ID,
        profilePath: freshProfilePath,
        localProfileId: "fresh-agent",
        modelSourceProfileId: "foreign-source",
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });
    expect(configureFreshProfileModel).not.toHaveBeenCalled();
  });

  it("restores verified private state into a fresh USER installation without importing historical RuntimeBindings", async () => {
    const stagingPath = join(root, "restore-staging");
    const provenancePath = join(root, "runtime-bindings.enc");
    mkdirSync(join(stagingPath, "memories"), { recursive: true });
    mkdirSync(join(stagingPath, "skills", "private"), {
      recursive: true,
    });
    writeFileSync(
      join(stagingPath, "memories", "MEMORY.md"),
      "restored memory\n",
    );
    writeFileSync(
      join(stagingPath, "skills", "private", "SKILL.md"),
      "restored private skill\n",
    );
    writeFileSync(provenancePath, "encrypted historical bindings");
    getVersion.mockImplementationOnce(async () => v1);

    const restored = await manager().activateVerifiedRestore({
      backupId: BACKUP_ID,
      sourceInstallationId: SOURCE_INSTALLATION_ID,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profileLineageId: PROFILE_LINEAGE_ID,
      name: "Fresh Agent",
      stagedProfilePath: stagingPath,
      encryptedRuntimeBindingProvenancePath: provenancePath,
    });

    expect(restored).toEqual({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profileId: "fresh-agent",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      sourceScope: "USER",
    });
    expect(
      readFileSync(join(freshProfilePath, "memories", "MEMORY.md"), "utf8"),
    ).toBe("restored memory\n");
    expect(
      readFileSync(
        join(freshProfilePath, "skills", "private", "SKILL.md"),
        "utf8",
      ),
    ).toBe("restored private skill\n");
    const restoreRecord = database.sqlite
      .prepare(
        `SELECT backup_id, source_installation_id, agent_installation_id,
                runtime_profile_id, profile_lineage_id,
                encrypted_runtime_binding_provenance,
                historical_sessions_read_only
         FROM encrypted_backup_restores`,
      )
      .get() as {
      encrypted_runtime_binding_provenance: Uint8Array;
    } & Record<string, unknown>;
    expect({
      ...restoreRecord,
      encrypted_runtime_binding_provenance: Buffer.from(
        restoreRecord.encrypted_runtime_binding_provenance,
      ),
    }).toEqual({
      backup_id: BACKUP_ID,
      source_installation_id: SOURCE_INSTALLATION_ID,
      agent_installation_id: AGENT_INSTALLATION_ID,
      runtime_profile_id: RUNTIME_PROFILE_ID,
      profile_lineage_id: PROFILE_LINEAGE_ID,
      encrypted_runtime_binding_provenance: Buffer.from(
        "encrypted historical bindings",
      ),
      historical_sessions_read_only: 1,
    });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 0 });
    expect(events.at(-1)).toBe("profile:activate:fresh-agent");
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("removes the transaction-owned Profile and binding when restore activation fails", async () => {
    const stagingPath = join(root, "restore-staging-failure");
    const provenancePath = join(root, "runtime-bindings-failure.enc");
    mkdirSync(join(stagingPath, "memories"), { recursive: true });
    writeFileSync(
      join(stagingPath, "memories", "MEMORY.md"),
      "must be deleted\n",
    );
    writeFileSync(provenancePath, "encrypted historical bindings");
    getVersion.mockImplementationOnce(async () => v1);
    activateInstallation.mockRejectedValueOnce(new Error("offline"));

    await expect(
      manager().activateVerifiedRestore({
        backupId: BACKUP_ID,
        sourceInstallationId: SOURCE_INSTALLATION_ID,
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileLineageId: PROFILE_LINEAGE_ID,
        name: "Fresh Agent",
        stagedProfilePath: stagingPath,
        encryptedRuntimeBindingProvenancePath: provenancePath,
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });

    expect(archiveInstallation).toHaveBeenCalledWith(
      AGENT_INSTALLATION_ID,
      `agentera:restore-archive:${AGENT_INSTALLATION_ID}:${BACKUP_ID}`,
    );
    expect(deleteProfile).toHaveBeenCalledWith("fresh-agent");
    expect(existsSync(freshProfilePath)).toBe(false);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM encrypted_backup_restores")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM local_agent_installations")
        .get(),
    ).toEqual({ count: 0 });
    expect(() =>
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toThrow();
  });

  it("binds a Workspace source while keeping the local Installation USER-owned", async () => {
    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: { scope: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "member" },
      profile: { kind: "fresh", name: "Fresh Agent" },
    });

    expect(createInstallation).toHaveBeenCalledWith(
      {
        definition_id: DEFINITION_ID,
        version_id: VERSION_ID,
        workspace_id: WORKSPACE_ID,
      } satisfies CreateAgentInstallationRequest,
      OPERATION_ID,
    );
    expect(installed).toMatchObject({
      sourceScope: "WORKSPACE",
      sourceWorkspaceId: WORKSPACE_ID,
      agentInstallationId: AGENT_INSTALLATION_ID,
      status: "active",
    });
    expect(manager().listLocalInstallations()).toEqual([]);
    expect(
      manager().listLocalInstallations({
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "member",
      }),
    ).toEqual([installed]);
    expect(
      database.sqlite
        .prepare(
          "SELECT tenant_id, owner_id, source_scope, source_workspace_id FROM local_agent_installations WHERE agent_installation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      tenant_id: owner.tenantId,
      owner_id: owner.ownerId,
      source_scope: "WORKSPACE",
      source_workspace_id: WORKSPACE_ID,
    });
  });

  it("binds an Organization source while keeping the local Installation USER-owned", async () => {
    const organizationProfilePath = join(profilesRoot, "organization-existing");
    const memoryPath = join(organizationProfilePath, "MEMORY.md");
    const privateSkillPath = join(
      organizationProfilePath,
      "skills",
      "local-only",
      "SKILL.md",
    );
    mkdirSync(join(organizationProfilePath, "skills", "local-only"), {
      recursive: true,
    });
    writeFileSync(memoryPath, "organization install private memory\n");
    writeFileSync(privateSkillPath, "organization install private skill\n");
    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      },
      profile: {
        kind: "claim",
        profileId: "organization-existing",
        profilePath: organizationProfilePath,
      },
    });

    expect(createInstallation).toHaveBeenCalledWith(
      {
        definition_id: DEFINITION_ID,
        version_id: VERSION_ID,
        organization_id: ORGANIZATION_ID,
      } satisfies CreateAgentInstallationRequest,
      OPERATION_ID,
    );
    expect(installed).toMatchObject({
      sourceScope: "ORGANIZATION",
      sourceWorkspaceId: null,
      sourceOrganizationId: ORGANIZATION_ID,
      agentInstallationId: AGENT_INSTALLATION_ID,
      status: "active",
    });
    expect(manager().listLocalInstallations()).toEqual([]);
    expect(
      manager().listLocalInstallations({
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      }),
    ).toEqual([installed]);
    expect(
      database.sqlite
        .prepare(
          "SELECT tenant_id, owner_id, source_scope, source_workspace_id, source_organization_id FROM local_agent_installations WHERE agent_installation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      tenant_id: owner.tenantId,
      owner_id: owner.ownerId,
      source_scope: "ORGANIZATION",
      source_workspace_id: null,
      source_organization_id: ORGANIZATION_ID,
    });
    const projected = materializeVersion.mock.results.at(-1)?.value;
    expect(projected).toBeDefined();
    expect(
      relative(
        organizationProfilePath,
        projected?.versionRoot ?? "",
      ).startsWith(".."),
    ).toBe(true);
    expect(
      relative(
        organizationProfilePath,
        projected?.externalSkillsDirectory ?? "",
      ).startsWith(".."),
    ).toBe(true);
    expect(readFileSync(memoryPath, "utf8")).toBe(
      "organization install private memory\n",
    );
    expect(readFileSync(privateSkillPath, "utf8")).toBe(
      "organization install private skill\n",
    );

    createInstallation.mockClear();
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        source: {
          scope: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          role: "auditor",
        },
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "invalid_installation_request" });
    expect(createInstallation).not.toHaveBeenCalled();
  });

  it("installs an exact PLATFORM release into a fresh non-cloned Profile", async () => {
    policy = makeOfficialPolicy(v1);
    createInstallation.mockResolvedValueOnce({
      installation: pendingOfficialInstallation(),
      policy_snapshot: policy,
      replayed: false,
    });
    activateInstallation.mockResolvedValueOnce(
      pendingOfficialInstallation("active"),
    );

    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: {
        scope: "PLATFORM",
        officialReleaseId: OFFICIAL_RELEASE_ID,
        selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
        updatePolicy: "managed",
      },
      profile: { kind: "fresh", name: "Fresh Agent" },
    });

    expect(createInstallation).toHaveBeenCalledWith(
      {
        definition_id: DEFINITION_ID,
        official_release_revision_id: OFFICIAL_RELEASE_REVISION_ID,
      } satisfies CreateAgentInstallationRequest,
      OPERATION_ID,
    );
    expect(createProfile).toHaveBeenCalledWith("Fresh Agent", null);
    expect(installed).toMatchObject({
      sourceScope: "PLATFORM",
      sourceWorkspaceId: null,
      sourceOrganizationId: null,
      officialReleaseId: OFFICIAL_RELEASE_ID,
      selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      updatePolicy: "managed",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT source_scope, source_workspace_id, source_organization_id,
             official_release_id, selected_release_revision_id, update_policy
           FROM local_agent_installations WHERE agent_installation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      source_scope: "PLATFORM",
      source_workspace_id: null,
      source_organization_id: null,
      official_release_id: OFFICIAL_RELEASE_ID,
      selected_release_revision_id: OFFICIAL_RELEASE_REVISION_ID,
      update_policy: "managed",
    });
  });

  it("rejects claiming an existing Profile for a PLATFORM source before Cloud mutation", async () => {
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        source: {
          scope: "PLATFORM",
          officialReleaseId: OFFICIAL_RELEASE_ID,
          selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
          updatePolicy: "managed",
        },
        profile: {
          kind: "claim",
          profileId: "existing",
          profilePath: join(profilesRoot, "existing"),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_installation_request" });
    expect(createInstallation).not.toHaveBeenCalled();
  });

  it("rejects a mismatched official release before local persistence or Profile creation", async () => {
    policy = makeOfficialPolicy(v1);
    createInstallation.mockResolvedValueOnce({
      installation: {
        ...pendingOfficialInstallation(),
        selected_release_revision_id: "12121212-1212-4212-8212-121212121212",
      },
      policy_snapshot: policy,
      replayed: false,
    });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        source: {
          scope: "PLATFORM",
          officialReleaseId: OFFICIAL_RELEASE_ID,
          selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
          updatePolicy: "managed",
        },
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "installation_conflict" });
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM local_agent_installations")
        .get(),
    ).toEqual({ count: 0 });
  });

  // @lat: [[agentera-agent-control-plane#Offline and failure behavior#Failure attribution by trust boundary]]
  it("reports a malformed cloud identifier as a conflict, not an invalid request", async () => {
    createInstallation.mockResolvedValueOnce({
      installation: { ...pendingInstallation(), id: "not-a-uuid" },
      policy_snapshot: policy,
      replayed: false,
    });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "installation_conflict" });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("retries official activation with the same created Profile and preserves local Memory", async () => {
    policy = makeOfficialPolicy(v1);
    getPolicySnapshot.mockResolvedValue(policy);
    createInstallation.mockResolvedValueOnce({
      installation: pendingOfficialInstallation(),
      policy_snapshot: policy,
      replayed: false,
    });
    activateInstallation
      .mockRejectedValueOnce(new Error("activation unavailable"))
      .mockResolvedValueOnce(pendingOfficialInstallation("active"));

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        source: {
          scope: "PLATFORM",
          officialReleaseId: OFFICIAL_RELEASE_ID,
          selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
          updatePolicy: "managed",
        },
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });
    writeFileSync(
      join(freshProfilePath, "MEMORY.md"),
      "official local memory\n",
    );

    const retried = await manager().retryPendingInstallation({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profile: {
        kind: "claim",
        profileId: "fresh-agent",
        profilePath: freshProfilePath,
      },
    });

    expect(retried).toMatchObject({
      sourceScope: "PLATFORM",
      officialReleaseId: OFFICIAL_RELEASE_ID,
      selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      status: "active",
    });
    expect(createProfile).toHaveBeenCalledOnce();
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(readFileSync(join(freshProfilePath, "MEMORY.md"), "utf8")).toBe(
      "official local memory\n",
    );
  });

  it("applies v2 and rollback in order while preserving every private Hermes fixture", async () => {
    await installOfficialV1();
    const privateFixtures = new Map([
      ["MEMORY.md", "private memory\n"],
      ["USER.md", "private user profile\n"],
      ["sessions/session.json", '{"private":"session"}\n'],
      ["files/private.txt", "private file\n"],
      ["skills/learned/SKILL.md", "private learned skill\n"],
      [".curator/state.json", '{"private":"curator"}\n'],
      ["credentials.json", '{"private":"credential"}\n'],
    ]);
    for (const [relativePath, content] of privateFixtures) {
      const path = join(freshProfilePath, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }

    const v2 = makeVersion(VERSION_2_ID, 2);
    const policy2 = makeOfficialPolicy(
      v2,
      OFFICIAL_RELEASE_REVISION_2_ID,
      POLICY_2_ID,
    );
    const update: OfficialManagedUpdate = {
      installationId: AGENT_INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      targetReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      targetVersionId: VERSION_2_ID,
    };
    events.length = 0;
    getManagedUpdate.mockResolvedValueOnce(update);
    getOfficialAgent.mockImplementationOnce(async () => {
      events.push("cloud:get-official-v2");
      return officialDetail(v2, OFFICIAL_RELEASE_REVISION_2_ID);
    });
    applyManagedUpdate.mockImplementationOnce(async () => {
      events.push("cloud:apply-managed-v2");
      return pendingOfficialInstallation("active", {
        versionId: VERSION_2_ID,
        policyId: POLICY_2_ID,
        releaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      });
    });
    getPolicySnapshot.mockImplementationOnce(async () => {
      events.push("cloud:get-policy-v2");
      return policy2;
    });
    policy = policy2;

    const updated = await manager().applyManagedOfficialUpdate(
      AGENT_INSTALLATION_ID,
    );

    expect(updated).toMatchObject({
      selectedVersionId: VERSION_2_ID,
      selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      policySnapshotId: POLICY_2_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      retryCode: null,
    });
    expect(events).toEqual([
      "cloud:get-official-v2",
      "verify-cache:version",
      `project:${VERSION_2_ID}`,
      "cloud:apply-managed-v2",
      "cloud:get-policy-v2",
      "verify:policy",
      `profile:project:${VERSION_2_ID}`,
    ]);
    expect(applyManagedUpdate).toHaveBeenLastCalledWith(
      AGENT_INSTALLATION_ID,
      OFFICIAL_RELEASE_REVISION_ID,
      OFFICIAL_RELEASE_REVISION_2_ID,
      `agentera:managed-update:${AGENT_INSTALLATION_ID}:${OFFICIAL_RELEASE_REVISION_ID}:${OFFICIAL_RELEASE_REVISION_2_ID}`,
    );

    const rollbackPolicy = makeOfficialPolicy(
      v1,
      OFFICIAL_RELEASE_REVISION_3_ID,
      POLICY_3_ID,
    );
    getManagedUpdate.mockResolvedValueOnce({
      installationId: AGENT_INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      targetReleaseRevisionId: OFFICIAL_RELEASE_REVISION_3_ID,
      targetVersionId: VERSION_ID,
    });
    getOfficialAgent.mockResolvedValueOnce(
      officialDetail(v1, OFFICIAL_RELEASE_REVISION_3_ID),
    );
    applyManagedUpdate.mockResolvedValueOnce(
      pendingOfficialInstallation("active", {
        versionId: VERSION_ID,
        policyId: POLICY_3_ID,
        releaseRevisionId: OFFICIAL_RELEASE_REVISION_3_ID,
      }),
    );
    getPolicySnapshot.mockResolvedValueOnce(rollbackPolicy);
    policy = rollbackPolicy;

    const rolledBack = await manager().applyManagedOfficialUpdate(
      AGENT_INSTALLATION_ID,
    );
    expect(rolledBack).toMatchObject({
      selectedVersionId: VERSION_ID,
      selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_3_ID,
      policySnapshotId: POLICY_3_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      retryCode: null,
    });
    for (const [relativePath, content] of privateFixtures) {
      expect(readFileSync(join(freshProfilePath, relativePath), "utf8")).toBe(
        content,
      );
    }
  });

  it("keeps v1 active across every failure before managed local activation", async () => {
    await installOfficialV1();
    const v2 = makeVersion(VERSION_2_ID, 2);
    const policy2 = makeOfficialPolicy(
      v2,
      OFFICIAL_RELEASE_REVISION_2_ID,
      POLICY_2_ID,
    );
    const update: OfficialManagedUpdate = {
      installationId: AGENT_INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      targetReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      targetVersionId: VERSION_2_ID,
    };
    getManagedUpdate.mockRejectedValueOnce(new Error("target unavailable"));
    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        retryCode: "managed_update_target_failed",
      },
    );

    getManagedUpdate.mockResolvedValueOnce(update);
    getVersion.mockRejectedValueOnce(new Error("version unavailable"));
    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        retryCode: "managed_update_version_failed",
      },
    );
    expect(applyManagedUpdate).not.toHaveBeenCalled();

    getVersion.mockResolvedValueOnce(v2);
    materializeVersion.mockImplementationOnce(() => {
      throw new Error("projection failed");
    });
    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        retryCode: "managed_update_projection_failed",
      },
    );
    expect(applyManagedUpdate).not.toHaveBeenCalled();

    getVersion.mockResolvedValueOnce(v2);
    applyManagedUpdate.mockRejectedValueOnce(new Error("cloud unavailable"));
    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        retryCode: "managed_update_cloud_failed",
      },
    );

    getVersion.mockResolvedValueOnce(v2);
    applyManagedUpdate.mockResolvedValueOnce(
      pendingOfficialInstallation("active", {
        versionId: VERSION_2_ID,
        policyId: POLICY_2_ID,
        releaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      }),
    );
    getPolicySnapshot.mockRejectedValueOnce(new Error("policy unavailable"));
    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
        retryCode: "managed_update_policy_failed",
      },
    );
    expect(activateForProfile).toHaveBeenCalledTimes(1);
    expect(policy2.document.official_context?.release_revision_id).toBe(
      OFFICIAL_RELEASE_REVISION_2_ID,
    );
  });

  it("reconciles Cloud success with the same idempotency key after local activation fails", async () => {
    await installOfficialV1();
    writeFileSync(join(freshProfilePath, "MEMORY.md"), "private memory\n");
    const v2 = makeVersion(VERSION_2_ID, 2);
    const policy2 = makeOfficialPolicy(
      v2,
      OFFICIAL_RELEASE_REVISION_2_ID,
      POLICY_2_ID,
    );
    getManagedUpdate.mockResolvedValueOnce({
      installationId: AGENT_INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      targetReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      targetVersionId: VERSION_2_ID,
    });
    getVersion.mockResolvedValue(v2);
    applyManagedUpdate.mockResolvedValue(
      pendingOfficialInstallation("active", {
        versionId: VERSION_2_ID,
        policyId: POLICY_2_ID,
        releaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      }),
    );
    getPolicySnapshot.mockResolvedValue(policy2);
    policy = policy2;
    activateForProfile
      .mockImplementationOnce(() => {
        throw new Error("local activation failed");
      })
      .mockImplementationOnce(({ projection }) => ({
        externalSkillsDirectory: projection.externalSkillsDirectory,
        diagnostics: [],
      }));

    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
        policySnapshotId: POLICY_ID,
        retryCode: "managed_update_activation_failed",
      },
    );
    const pending = database.sqlite
      .prepare(
        `SELECT payload_json FROM pending_sanitized_records
         WHERE record_type = 'official_managed_update'`,
      )
      .get() as { payload_json: string };
    expect(JSON.parse(pending.payload_json)).toEqual({
      agent_installation_id: AGENT_INSTALLATION_ID,
      expected_selected_release_revision_id: OFFICIAL_RELEASE_REVISION_ID,
      target_release_revision_id: OFFICIAL_RELEASE_REVISION_2_ID,
      target_version_id: VERSION_2_ID,
      idempotency_key: `agentera:managed-update:${AGENT_INSTALLATION_ID}:${OFFICIAL_RELEASE_REVISION_ID}:${OFFICIAL_RELEASE_REVISION_2_ID}`,
    });

    await expect(
      manager().applyManagedOfficialUpdate(AGENT_INSTALLATION_ID),
    ).resolves.toMatchObject({
      selectedVersionId: VERSION_2_ID,
      selectedReleaseRevisionId: OFFICIAL_RELEASE_REVISION_2_ID,
      policySnapshotId: POLICY_2_ID,
      retryCode: null,
    });
    expect(getManagedUpdate).toHaveBeenCalledOnce();
    expect(applyManagedUpdate).toHaveBeenCalledTimes(2);
    expect(applyManagedUpdate.mock.calls[0][3]).toBe(
      applyManagedUpdate.mock.calls[1][3],
    );
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM pending_sanitized_records
           WHERE record_type = 'official_managed_update'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(readFileSync(join(freshProfilePath, "MEMORY.md"), "utf8")).toBe(
      "private memory\n",
    );
  });

  it("does not expose one product account's installation to another", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const other = manager({
      tenantId: "12121212-1212-4121-8121-121212121212",
      ownerId: "13131313-1313-4131-8131-131313131313",
      deviceInstallationId: "14141414-1414-4141-8141-141414141414",
    });
    expect(other.listLocalInstallations()).toEqual([]);
    expect(() => other.getLocalInstallation(AGENT_INSTALLATION_ID)).toThrow(
      expect.objectContaining({ code: "installation_not_found" }),
    );
    expect(manager().listLocalInstallations()).toHaveLength(1);
  });

  it("uses only an explicit same-owner claim for an existing Profile", async () => {
    const claimed = join(profilesRoot, "existing");
    mkdirSync(join(claimed, "skills", "learned"), { recursive: true });
    writeFileSync(
      join(claimed, "skills", "learned", "SKILL.md"),
      "private learned skill\n",
    );
    const privateBefore = readFileSync(
      join(claimed, "skills", "learned", "SKILL.md"),
    );

    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "claim", profileId: "existing", profilePath: claimed },
    });

    expect(createProfile).not.toHaveBeenCalled();
    expect(
      readFileSync(join(claimed, "skills", "learned", "SKILL.md")),
    ).toEqual(privateBefore);
    expect(bindings.verifyProfileBinding(claimed, owner)).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
    });
  });

  it("reuses a persisted create idempotency key after an ambiguous cloud failure", async () => {
    createInstallation.mockRejectedValueOnce(new Error("response lost"));
    const request = {
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh" as const, name: "Fresh Agent" },
    };

    await expect(manager().install(request)).rejects.toMatchObject({
      code: "creation_failed",
    });
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
        )
        .get(),
    ).toEqual({ count: 1 });

    await expect(manager().install(request)).resolves.toMatchObject({
      status: "active",
    });
    expect(createInstallation.mock.calls[0][1]).toBe(OPERATION_ID);
    expect(createInstallation.mock.calls[1][1]).toBe(OPERATION_ID);
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("leaves a failed download pending and retries without creating another cloud installation", async () => {
    getVersion.mockRejectedValueOnce(new Error("offline"));
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "materialization_failed" });
    expect(createProfile).not.toHaveBeenCalled();
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        status: "pending",
        retryCode: "materialization_version_failed",
        runtimeProfileId: null,
      },
    );

    const retried = await manager().retryPendingInstallation({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    expect(retried.status).toBe("active");
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(getPolicySnapshot).toHaveBeenCalledWith(POLICY_ID);
  });

  it("preserves and reuses an attached Profile after activation failure", async () => {
    activateInstallation.mockRejectedValueOnce(new Error("activation offline"));
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });
    writeFileSync(join(freshProfilePath, "MEMORY.md"), "learned locally\n");
    expect(
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
    });

    const retried = await manager().retryPendingInstallation({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profile: {
        kind: "claim",
        profileId: "fresh-agent",
        profilePath: freshProfilePath,
      },
    });
    expect(retried.status).toBe("active");
    expect(createProfile).toHaveBeenCalledOnce();
    expect(activateInstallation).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(freshProfilePath, "MEMORY.md"), "utf8")).toBe(
      "learned locally\n",
    );
  });

  it("materializes a verified manual update before cloud selection and keeps the prior version", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    events = [];
    const v2 = makeVersion(VERSION_2_ID, 2);
    policy = makePolicy(v2, POLICY_2_ID);
    getVersion.mockImplementationOnce(async () => {
      events.push("cloud:get-version");
      return v2;
    });
    getPolicySnapshot.mockImplementationOnce(async (id) => {
      expect(id).toBe(POLICY_2_ID);
      events.push("cloud:get-policy");
      return policy;
    });
    selectInstallationVersion.mockImplementationOnce(async () => {
      events.push("cloud:select-version");
      return {
        ...pendingInstallation(VERSION_2_ID),
        policy_snapshot_id: POLICY_2_ID,
        runtime_profile_id: RUNTIME_PROFILE_ID,
        status: "active",
        activated_at: NOW.toISOString(),
      };
    });
    cache.cacheVerifiedVersion = vi.fn((candidate) => {
      events.push(`verify-cache:${candidate.id}`);
      return candidate;
    });

    const updated = await manager().selectInstallationVersion({
      agentInstallationId: AGENT_INSTALLATION_ID,
      versionId: VERSION_2_ID,
      profilePath: freshProfilePath,
    });

    expect(events).toEqual([
      "cloud:get-version",
      `verify-cache:${VERSION_2_ID}`,
      `project:${VERSION_2_ID}`,
      "cloud:select-version",
      "cloud:get-policy",
      "verify:policy",
      `profile:project:${VERSION_2_ID}`,
    ]);
    expect(updated.selectedVersionId).toBe(VERSION_2_ID);
    expect(cache.cacheVerifiedPolicySnapshot).toHaveBeenLastCalledWith(
      VERSION_2_ID,
      policy,
    );
    expect(materializeVersion).toHaveBeenCalledWith({
      agentInstallationId: AGENT_INSTALLATION_ID,
      version: v2,
    });
    expect(existsSync(freshProfilePath)).toBe(true);
  });

  it("keeps the last local version selected when the new cloud policy cannot be verified", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const activationCallsBeforeUpdate = activateForProfile.mock.calls.length;
    const v2 = makeVersion(VERSION_2_ID, 2);
    getVersion.mockResolvedValueOnce(v2);
    selectInstallationVersion.mockResolvedValueOnce({
      ...pendingInstallation(VERSION_2_ID),
      policy_snapshot_id: POLICY_2_ID,
      runtime_profile_id: RUNTIME_PROFILE_ID,
      status: "active",
      activated_at: NOW.toISOString(),
    });
    getPolicySnapshot.mockRejectedValueOnce(new Error("policy unavailable"));

    await expect(
      manager().selectInstallationVersion({
        agentInstallationId: AGENT_INSTALLATION_ID,
        versionId: VERSION_2_ID,
        profilePath: freshProfilePath,
      }),
    ).rejects.toMatchObject({ code: "update_failed" });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        selectedVersionId: VERSION_ID,
        policySnapshotId: POLICY_ID,
      },
    );
    expect(activateForProfile).toHaveBeenCalledTimes(
      activationCallsBeforeUpdate,
    );
  });

  it.each([
    "partial_download",
    "signature_mismatch",
    "digest_mismatch",
    "runtime_incompatible",
    "policy_denied",
    "membership_removed",
    "organization_archived",
  ] as const)(
    "preserves an Organization Profile and private learning when update fails with %s",
    async (failure) => {
      await manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        source: {
          scope: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          role: "member",
        },
        profile: { kind: "fresh", name: "Fresh Agent" },
      });
      const privateSkillPath = join(
        freshProfilePath,
        "skills",
        "locally-learned",
        "SKILL.md",
      );
      mkdirSync(join(freshProfilePath, "skills", "locally-learned"), {
        recursive: true,
      });
      writeFileSync(privateSkillPath, `private before ${failure}\n`);
      const activationCalls = activateForProfile.mock.calls.length;
      const v2 = makeVersion(VERSION_2_ID, 2);
      const nextPolicy = makePolicy(v2, POLICY_2_ID);

      getVersion.mockResolvedValueOnce(v2);
      selectInstallationVersion.mockResolvedValueOnce({
        ...pendingInstallation(VERSION_2_ID),
        policy_snapshot_id: POLICY_2_ID,
        runtime_profile_id: RUNTIME_PROFILE_ID,
        status: "active",
        activated_at: NOW.toISOString(),
      });
      getPolicySnapshot.mockResolvedValueOnce(nextPolicy);
      if (failure === "partial_download") {
        getVersion.mockReset().mockRejectedValueOnce(new Error(failure));
      } else if (
        failure === "signature_mismatch" ||
        failure === "digest_mismatch"
      ) {
        cache.cacheVerifiedVersion = vi.fn(() => {
          throw new Error(failure);
        });
      } else if (
        failure === "runtime_incompatible" ||
        failure === "policy_denied"
      ) {
        trust.verifyPolicy = vi.fn(() => {
          throw new Error(failure);
        });
      } else {
        selectInstallationVersion
          .mockReset()
          .mockRejectedValueOnce(new Error(failure));
      }

      await expect(
        manager().selectInstallationVersion({
          agentInstallationId: AGENT_INSTALLATION_ID,
          versionId: VERSION_2_ID,
          profilePath: freshProfilePath,
        }),
      ).rejects.toMatchObject({ code: "update_failed" });
      expect(
        manager().getLocalInstallation(AGENT_INSTALLATION_ID),
      ).toMatchObject({
        sourceScope: "ORGANIZATION",
        sourceOrganizationId: ORGANIZATION_ID,
        selectedVersionId: VERSION_ID,
        policySnapshotId: POLICY_ID,
        runtimeProfileId: RUNTIME_PROFILE_ID,
      });
      expect(activateForProfile).toHaveBeenCalledTimes(activationCalls);
      expect(readFileSync(privateSkillPath, "utf8")).toBe(
        `private before ${failure}\n`,
      );
      expect(existsSync(freshProfilePath)).toBe(true);
    },
  );

  it("archives metadata only and never deletes the Profile or local learning", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    writeFileSync(join(freshProfilePath, "MEMORY.md"), "keep forever\n");

    const archived = await manager().archiveInstallation(AGENT_INSTALLATION_ID);

    expect(archiveInstallation).toHaveBeenCalledOnce();
    expect(archived.status).toBe("archived");
    expect(existsSync(freshProfilePath)).toBe(true);
    expect(readFileSync(join(freshProfilePath, "MEMORY.md"), "utf8")).toBe(
      "keep forever\n",
    );
    expect(
      bindings.verifyProfileBinding(freshProfilePath, owner)
        .agentInstallationId,
    ).toBe(AGENT_INSTALLATION_ID);
    expect(cache.getVerifiedPolicySnapshot(VERSION_ID, POLICY_ID)).toEqual(
      policy,
    );
  });
});
