// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
import {
  CapabilityBindingStore,
  type LocalMcpCapabilityServer,
} from "./capability-binding-store";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_AGENT_INSTALLATION_ID = "20202020-2020-4020-8020-202020202020";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const RUNTIME_PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_DEFINITION_ID = "21212121-2121-4121-8121-212121212121";
const SECOND_VERSION_ID = "23232323-2323-4323-8323-232323232323";
const SECOND_OPERATION_ID = "24242424-2424-4424-8424-242424242424";
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

function makeVersionV3(): AgentVersion {
  const editable: AgentEditableManifest = {
    schemaVersion: 3,
    identity: { systemPrompt: "Installed capability-bound base." },
    assets: [],
    modelPolicy: {
      mode: "allowlist",
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    mcpRequirements: [
      {
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read approved private documents",
      },
    ],
    tools: { allowed: ["docs.read"], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
  const canonical = canonicalizeEditableAgent(editable, []);
  return {
    id: VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 1,
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
  if (version.manifest.schema_version !== 1) {
    throw new Error("V1 policy fixture requires a V1 manifest");
  }
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

function makePolicyV3(version: AgentVersion): AgentPolicySnapshot {
  if (version.manifest.schema_version !== 3) {
    throw new Error("V3 policy fixture requires a V3 manifest");
  }
  return {
    id: POLICY_ID,
    installation_id: AGENT_INSTALLATION_ID,
    agent_version_id: version.id,
    issuer: ORIGIN,
    policy_version: 1,
    document: {
      schema_version: 3,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: version.id,
      version_digest: version.content_digest,
      model_policy: version.manifest.model_policy,
      mcp_requirements: version.manifest.mcp_requirements,
      runtime_compatibility: version.manifest.runtime_compatibility,
      tools: version.manifest.tools,
      deny_rules: [],
      publication_allowed: false,
    },
    content_digest: "ac".repeat(32),
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
const otherOwner: AgenteraRuntimeOwner = {
  tenantId: "10101010-1010-4010-8010-101010101010",
  ownerId: "11111111-2222-4222-8222-222222222222",
  deviceInstallationId: owner.deviceInstallationId,
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
  let recordDeliveryVerification: Mock<
    AgentInstallationClient["recordOfficialAgentDeliveryVerification"]
  >;
  let materializeVersion: Mock<
    AgentInstallationProjection["materializeVersion"]
  >;
  let activateForProfile: Mock<
    AgentInstallationProjection["activateForProfile"]
  >;
  let profileIdForAgentName: Mock<
    AgentInstallationProfileAdapter["profileIdForAgentName"]
  >;
  let createProfile: Mock<AgentInstallationProfileAdapter["createProfile"]>;
  let prepareProfile: Mock<
    NonNullable<AgentInstallationProfileAdapter["prepareProfile"]>
  >;
  let resetInterruptedFreshProfile: Mock<
    NonNullable<AgentInstallationProfileAdapter["resetInterruptedFreshProfile"]>
  >;
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
    recordDeliveryVerification = vi
      .fn<AgentInstallationClient["recordOfficialAgentDeliveryVerification"]>()
      .mockResolvedValue({
        request_id: OPERATION_ID,
        status: "accepted",
        received_at: NOW.toISOString(),
      });
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
      getOfficialDesktopVersion: () => "v0.7.4",
      recordOfficialAgentDeliveryVerification: recordDeliveryVerification,
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
    profileIdForAgentName = vi
      .fn<AgentInstallationProfileAdapter["profileIdForAgentName"]>()
      .mockReturnValue("fresh-agent");
    createProfile = vi
      .fn<AgentInstallationProfileAdapter["createProfile"]>()
      .mockImplementation((name, cloneFrom, reservedProfileId) => {
        events.push(`profile:create:${String(cloneFrom)}`);
        void reservedProfileId;
        expect(name).toBe("Fresh Agent");
        mkdirSync(freshProfilePath, { recursive: true });
        return { success: true, id: "fresh-agent" };
      });
    deleteProfile = vi.fn((id: string) => {
      events.push(`profile:delete:${id}`);
      rmSync(freshProfilePath, { recursive: true, force: true });
      return { success: true };
    });
    prepareProfile = vi.fn(
      async (name, cloneFrom, reservedProfileId, sourceKind) => {
        expect(name).toBe("Fresh Agent");
        expect(cloneFrom).toBeNull();
        const id = reservedProfileId ?? "fresh-agent";
        const destinationPath = join(profilesRoot, id);
        const candidatePath = join(root, `prepared-${id}-${sourceKind}`);
        mkdirSync(candidatePath, { recursive: true });
        writeFileSync(join(candidatePath, ".env"), "# staged\n");
        events.push(`profile:prepare:${sourceKind}`);
        return {
          success: true,
          id,
          candidate: {
            stagingPath: candidatePath,
            destinationPath,
            materialize: async <T>(
              callback: (context: {
                stagingHome: string;
                stagingPath: string;
              }) => T | Promise<T>,
            ): Promise<T> =>
              callback({ stagingHome: root, stagingPath: candidatePath }),
            activate: async (activation?: {
              authorize?: () => boolean | Promise<boolean>;
            }) => {
              if (activation?.authorize && !(await activation.authorize())) {
                throw new Error("staged owner changed");
              }
              renameSync(candidatePath, destinationPath);
              events.push(`profile:publish:${sourceKind}`);
              return destinationPath;
            },
            cleanup: async () => {
              rmSync(candidatePath, { recursive: true, force: true });
            },
          },
        };
      },
    );
    resetInterruptedFreshProfile = vi.fn(async (id: string) => {
      expect(id).toBe("fresh-agent");
      rmSync(freshProfilePath, { recursive: true, force: true });
      events.push(`profile:reset-interrupted:${id}`);
    });
    profiles = {
      profileIdForAgentName,
      createProfile,
      prepareProfile,
      resetInterruptedFreshProfile,
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

  function manager(
    ownerOverride = owner,
    randomUUID: () => string = () => OPERATION_ID,
    capabilityOptions: {
      capabilityBindingStore: CapabilityBindingStore;
      getProfileMcpCapabilities: (
        profilePath: string,
      ) => LocalMcpCapabilityServer[];
    } | null = null,
  ): AgentInstallationManager {
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
      randomUUID,
      ...(capabilityOptions ?? {}),
    });
  }

  function coldRestartManager(): AgentInstallationManager {
    database.close();
    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => RUNTIME_PROFILE_ID,
    });
    return manager();
  }

  function failJournalAdvanceTo(phase: string): void {
    database.sqlite.exec(`
      CREATE TRIGGER injected_installation_operation_failure
      BEFORE UPDATE OF phase ON installation_operations
      WHEN NEW.phase = '${phase}'
      BEGIN
        SELECT RAISE(ABORT, 'injected journal failure');
      END;
    `);
  }

  function clearJournalFailure(): void {
    database.sqlite.exec(
      "DROP TRIGGER IF EXISTS injected_installation_operation_failure",
    );
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
    expect(profileIdForAgentName).toHaveBeenCalledWith("Fresh Agent");
    expect(prepareProfile).toHaveBeenCalledWith(
      "Fresh Agent",
      null,
      "fresh-agent",
      "agent_projection",
    );
    expect(createProfile).not.toHaveBeenCalled();
    expect(events).toEqual([
      "cloud:create-pending",
      "cloud:get-version",
      "verify-cache:version",
      "verify:policy",
      `project:${VERSION_ID}`,
      "profile:prepare:agent_projection",
      `profile:project:${VERSION_ID}`,
      "profile:publish:agent_projection",
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

  it("materializes a fresh Agent projection in staging before one live activation", async () => {
    const candidatePath = join(root, "fresh-agent-candidate");
    const prepare = vi.fn(async (...args: unknown[]) => {
      expect(args.slice(0, 4)).toEqual([
        "Fresh Agent",
        null,
        "fresh-agent",
        "agent_projection",
      ]);
      mkdirSync(candidatePath, { recursive: true });
      writeFileSync(join(candidatePath, ".env"), "# staged\n");
      return {
        success: true,
        id: "fresh-agent",
        candidate: {
          stagingPath: candidatePath,
          destinationPath: freshProfilePath,
          materialize: async <T>(
            callback: (context: {
              stagingHome: string;
              stagingPath: string;
            }) => T | Promise<T>,
          ): Promise<T> => {
            expect(existsSync(freshProfilePath)).toBe(false);
            return callback({ stagingHome: root, stagingPath: candidatePath });
          },
          activate: async (activation?: {
            authorize?: () => boolean | Promise<boolean>;
          }) => {
            expect(await activation?.authorize?.()).toBe(true);
            expect(existsSync(join(candidatePath, "projection.json"))).toBe(
              true,
            );
            expect(existsSync(freshProfilePath)).toBe(false);
            renameSync(candidatePath, freshProfilePath);
            events.push("profile:activate-staged:agent_projection");
            return freshProfilePath;
          },
          cleanup: async () => {
            rmSync(candidatePath, { recursive: true, force: true });
          },
        },
      };
    });
    profiles.prepareProfile = prepare as AgentInstallationProfileAdapter["prepareProfile"];
    createProfile.mockImplementation(() => {
      throw new Error("live createProfile must not be used for Agent projection");
    });
    activateForProfile.mockImplementationOnce(({ profilePath, projection }) => {
      expect(profilePath).toBe(candidatePath);
      expect(existsSync(freshProfilePath)).toBe(false);
      writeFileSync(join(candidatePath, "projection.json"), "{}\n");
      events.push(`profile:project:${projection.versionId}`);
      return {
        externalSkillsDirectory: projection.externalSkillsDirectory,
        diagnostics: [],
      };
    });

    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
    expect(existsSync(join(freshProfilePath, "projection.json"))).toBe(true);
    expect(events).toEqual([
      "cloud:create-pending",
      "cloud:get-version",
      "verify-cache:version",
      "verify:policy",
      `project:${VERSION_ID}`,
      `profile:project:${VERSION_ID}`,
      "profile:activate-staged:agent_projection",
      "cloud:activate",
      "profile:activate:fresh-agent",
    ]);
    expect(installed).toMatchObject({
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
    });
  });

  it("keeps a V3 installation pending until required Profile capability mapping is configured", async () => {
    v1 = makeVersionV3();
    policy = makePolicyV3(v1);
    createInstallation.mockResolvedValue({
      installation: pendingInstallation(),
      policy_snapshot: policy,
      replayed: false,
    });
    getPolicySnapshot.mockResolvedValue(policy);
    const capabilityBindingStore = new CapabilityBindingStore({
      database,
      owner,
      now: () => NOW,
    });
    let capabilities: LocalMcpCapabilityServer[] = [];
    const capabilityOptions = {
      capabilityBindingStore,
      getProfileMcpCapabilities: () => capabilities,
    };
    const subject = manager(owner, () => OPERATION_ID, capabilityOptions);

    await expect(
      subject.install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({
      code: "profile_capability_configuration_required",
    });
    const pending = subject.getLocalInstallation(AGENT_INSTALLATION_ID);
    expect(pending).toMatchObject({
      status: "pending",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      retryCode: "profile_capability_configuration_required",
    });
    expect(activateInstallation).not.toHaveBeenCalled();

    capabilityBindingStore.upsert({
      agentInstallationId: AGENT_INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.read"],
      expectedRevision: null,
    });
    capabilities = [
      { name: "employee-docs", enabled: true, tools: ["docs.read"] },
    ];

    await expect(
      subject.retryPendingInstallation({
        agentInstallationId: AGENT_INSTALLATION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).resolves.toMatchObject({ status: "active", retryCode: null });
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(activateInstallation).toHaveBeenCalledOnce();
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Installation reconciliation isolation#Fresh reservation finalization recovery]]
  it("cold-restarts finalization when fresh Profile reservation completion fails", async () => {
    vi.spyOn(
      bindings,
      "completeFreshProfileReservation",
    ).mockImplementationOnce(() => {
      throw new Error("injected reservation completion failure");
    });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });

    expect(
      database.sqlite
        .prepare(
          `SELECT phase FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "cloud_activated" });
    expect(
      database.sqlite
        .prepare(
          `SELECT status, retry_code FROM local_agent_installations
           WHERE agent_installation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ status: "pending", retry_code: "activation_failed" });
    expect(
      bindings.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).not.toBeNull();
    expect(events).not.toContain("profile:activate:fresh-agent");

    await expect(
      coldRestartManager().reconcilePendingInstallations(),
    ).resolves.toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        status: "active",
      }),
    ]);
    expect(activateInstallation).toHaveBeenCalledOnce();
    expect(
      bindings.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).toBeNull();
    expect(
      database.sqlite
        .prepare(
          `SELECT phase FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "committed" });
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Installation reconciliation isolation#Fresh Profile activation recovery]]
  it("cold-restarts finalization when fresh Profile activation fails", async () => {
    const activateProfile = vi
      .fn<AgentInstallationProfileAdapter["activateProfile"]>()
      .mockImplementationOnce((id) => {
        events.push(`profile:activate:${id}:failed`);
        throw new Error("injected Profile activation failure");
      })
      .mockImplementation((id) => events.push(`profile:activate:${id}`));
    profiles.activateProfile = activateProfile;

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });

    expect(
      database.sqlite
        .prepare(
          `SELECT phase FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "cloud_activated" });
    expect(
      database.sqlite
        .prepare(
          `SELECT status, retry_code FROM local_agent_installations
           WHERE agent_installation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ status: "pending", retry_code: "activation_failed" });
    expect(
      bindings.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).toBeNull();

    await expect(
      coldRestartManager().reconcilePendingInstallations(),
    ).resolves.toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        status: "active",
      }),
    ]);
    expect(activateInstallation).toHaveBeenCalledOnce();
    expect(activateProfile).toHaveBeenCalledTimes(2);
    expect(
      database.sqlite
        .prepare(
          `SELECT phase FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "committed" });
  });

  it("recovers a reserved Profile after creation is interrupted and Desktop cold-restarts", async () => {
    prepareProfile.mockRejectedValueOnce(
      new Error("injected staging interruption"),
    );

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });
    expect(
      database.sqlite
        .prepare(
          "SELECT phase FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "prepared" });

    const recovered =
      await coldRestartManager().reconcilePendingInstallations();

    expect(recovered).toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        runtimeProfileId: RUNTIME_PROFILE_ID,
        status: "active",
      }),
    ]);
    expect(prepareProfile).toHaveBeenCalledTimes(2);
    expect(resetInterruptedFreshProfile).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Installation reconciliation isolation]]
  it("does not let a missing-installation operation block later recovery", async () => {
    prepareProfile.mockRejectedValueOnce(
      new Error("injected staging interruption"),
    );

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    database.sqlite
      .prepare(
        `INSERT INTO installation_operations (
           operation_id, tenant_id, owner_id, device_installation_id,
           agent_installation_id, target_kind, target_profile_id,
           display_name, model_source_profile_id, model_source_model_id,
           runtime_profile_id, phase, retry_code, revision,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'fresh', 'missing-agent',
           'Missing Agent', NULL, NULL, NULL, 'prepared', NULL, 1, ?, ?)`,
      )
      .run(
        MISSING_AGENT_INSTALLATION_ID,
        owner.tenantId,
        owner.ownerId,
        owner.deviceInstallationId,
        MISSING_AGENT_INSTALLATION_ID,
        NOW.toISOString(),
        NOW.toISOString(),
      );

    const recovered =
      await coldRestartManager().reconcilePendingInstallations();

    expect(recovered).toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        runtimeProfileId: RUNTIME_PROFILE_ID,
        status: "active",
      }),
    ]);
    expect(
      database.sqlite
        .prepare(
          `SELECT phase, retry_code FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(MISSING_AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "installation_not_found",
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
        policy: AgentPolicySnapshot;
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
      policy,
    });
    expect(events).toEqual([
      "cloud:create-pending",
      "cloud:get-version",
      "verify-cache:version",
      "verify:policy",
      `project:${VERSION_ID}`,
      "profile:prepare:agent_projection",
      "profile:model:fresh-agent",
      `profile:project:${VERSION_ID}`,
      "profile:publish:agent_projection",
      "cloud:activate",
      "profile:activate:fresh-agent",
    ]);
  });

  it("preserves and reconciles the reserved Profile when signed model configuration fails", async () => {
    const sourceProfilePath = join(profilesRoot, "source-profile");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "source-profile"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => "19191919-1919-4919-8919-191919191919",
    });
    bindings.bindExistingProfile(sourceProfilePath, owner);
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => RUNTIME_PROFILE_ID,
    });
    profiles.configureFreshProfileModel = vi.fn(async () => {
      events.push("profile:model:failed");
      await Promise.resolve();
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
    ).rejects.toMatchObject({
      code: "profile_model_configuration_failed",
    });

    expect(deleteProfile).not.toHaveBeenCalled();
    expect(existsSync(freshProfilePath)).toBe(false);
    expect(
      bindings.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).toMatchObject({
      operationId: AGENT_INSTALLATION_ID,
      profileId: "fresh-agent",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
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

    profiles.configureFreshProfileModel = vi.fn();
    await expect(
      coldRestartManager().reconcilePendingInstallations(),
    ).resolves.toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        status: "active",
      }),
    ]);
    expect(prepareProfile).toHaveBeenCalledTimes(2);
    expect(createProfile).not.toHaveBeenCalled();
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Installation reconciliation isolation#Interrupted fresh Profile retry evidence]]
  it("retries a known safe Beta.37 half-Profile through staged activation", async () => {
    const sourceProfilePath = join(profilesRoot, "source-profile");
    mkdirSync(sourceProfilePath, { recursive: true });
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "source-profile"
        ? sourceProfilePath
        : originalResolveProfilePath(id),
    );
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => "19191919-1919-4919-8919-191919191919",
    });
    bindings.bindExistingProfile(sourceProfilePath, owner);
    bindings = new AgenteraProfileBindingStore({
      userDataPath,
      secureStorage: new FakeSecureStorage(),
      now: () => NOW,
      randomUUID: () => RUNTIME_PROFILE_ID,
    });
    prepareProfile.mockImplementationOnce(async () => {
      mkdirSync(join(freshProfilePath, "sessions"), { recursive: true });
      mkdirSync(join(freshProfilePath, "skills"), { recursive: true });
      writeFileSync(join(freshProfilePath, ".env"), "# interrupted seed\n");
      writeFileSync(join(freshProfilePath, "SOUL.md"), "# Fresh Agent\n");
      throw new Error("injected Runtime staging interruption");
    });
    profiles.configureFreshProfileModel = vi.fn(async () => {
      if (existsSync(freshProfilePath)) {
        throw new Error("model_configuration_mutation_unavailable");
      }
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
    expect(
      database.sqlite
        .prepare(
          `SELECT retry_code FROM local_agent_installations
           WHERE agent_installation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ retry_code: "profile_creation_failed" });
    const reservation = bindings.getFreshProfileReservation(
      AGENT_INSTALLATION_ID,
      owner,
    );
    expect(reservation).toMatchObject({
      profileId: "fresh-agent",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });

    const retried = await manager().retryPendingInstallation({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profile: {
        kind: "fresh",
        name: "Fresh Agent",
        modelSourceProfileId: "source-profile",
      },
    });

    expect(retried).toMatchObject({
      status: "active",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
    expect(prepareProfile).toHaveBeenCalledTimes(2);
    expect(resetInterruptedFreshProfile).toHaveBeenCalledOnce();
    expect(
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toMatchObject({
      runtimeProfileId: reservation?.runtimeProfileId,
      agentInstallationId: AGENT_INSTALLATION_ID,
    });
  });

  it("preserves a pre-existing scaffold without durable interruption evidence", async () => {
    mkdirSync(join(freshProfilePath, "sessions"), { recursive: true });
    mkdirSync(join(freshProfilePath, "skills"), { recursive: true });
    writeFileSync(join(freshProfilePath, ".env"), "user-owned value\n");
    writeFileSync(join(freshProfilePath, "SOUL.md"), "# Existing\n");

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(readFileSync(join(freshProfilePath, ".env"), "utf8")).toBe(
      "user-owned value\n",
    );
    expect(resetInterruptedFreshProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "profile_private_data_conflict",
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
      policy,
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

  it("validates an active Agent model in place when its Profile is the selected source", async () => {
    await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const configureFreshProfileModel = vi.fn();
    profiles.configureFreshProfileModel = configureFreshProfileModel;

    const repaired = await manager().repairInstallationModel({
      agentInstallationId: AGENT_INSTALLATION_ID,
      profilePath: freshProfilePath,
      localProfileId: "fresh-agent",
      modelSourceProfileId: "fresh-agent",
    });

    expect(configureFreshProfileModel).toHaveBeenCalledWith({
      sourceProfileId: "fresh-agent",
      targetProfileId: "fresh-agent",
      version: v1,
      policy,
    });
    expect(repaired).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      selectedVersionId: VERSION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
      retryCode: null,
    });
  });

  it("reports the signed model compatibility failure while repairing an active installation", async () => {
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
    profiles.configureFreshProfileModel = vi.fn(async () => {
      await Promise.resolve();
      throw new Error(
        "The source Profile model is not allowed by the signed Agent version.",
      );
    });

    await expect(
      manager().repairInstallationModel({
        agentInstallationId: AGENT_INSTALLATION_ID,
        profilePath: freshProfilePath,
        localProfileId: "fresh-agent",
        modelSourceProfileId: "source-profile",
      }),
    ).rejects.toMatchObject({
      code: "profile_model_configuration_failed",
    });
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

  // @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Recoverable model configuration#Staged Profile activation protects live state]]
  it("merges encrypted restore bytes in staging before one live Profile activation", async () => {
    const restoreSource = join(root, "restore-source-isolated");
    const provenancePath = join(root, "runtime-bindings-isolated.enc");
    const candidatePath = join(root, "profile-candidate");
    mkdirSync(join(restoreSource, "memories"), { recursive: true });
    writeFileSync(
      join(restoreSource, "memories", "MEMORY.md"),
      "isolated restored memory\n",
    );
    writeFileSync(provenancePath, "encrypted historical bindings");
    getVersion.mockImplementationOnce(async () => v1);
    const activate = vi.fn(
      async (activation?: { authorize?: () => boolean | Promise<boolean> }) => {
        expect(activation?.authorize).toEqual(expect.any(Function));
        expect(await activation?.authorize?.()).toBe(true);
        expect(existsSync(freshProfilePath)).toBe(false);
        expect(
          readFileSync(join(candidatePath, "memories", "MEMORY.md"), "utf8"),
        ).toBe("isolated restored memory\n");
        renameSync(candidatePath, freshProfilePath);
        return freshProfilePath;
      },
    );
    Object.assign(profiles as object, {
      prepareProfile: vi.fn(async () => {
        mkdirSync(candidatePath, { recursive: true });
        writeFileSync(join(candidatePath, ".env"), "# staged\n");
        return {
          success: true,
          id: "fresh-agent",
          candidate: {
            stagingPath: candidatePath,
            destinationPath: freshProfilePath,
            activate,
            cleanup: vi.fn(async () => {
              rmSync(candidatePath, { recursive: true, force: true });
            }),
          },
        };
      }),
    });
    createProfile.mockImplementation(() => {
      throw new Error("live createProfile must not be used by restore");
    });

    await manager().activateVerifiedRestore({
      backupId: BACKUP_ID,
      sourceInstallationId: SOURCE_INSTALLATION_ID,
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profileLineageId: PROFILE_LINEAGE_ID,
      name: "Fresh Agent",
      stagedProfilePath: restoreSource,
      encryptedRuntimeBindingProvenancePath: provenancePath,
    });

    expect(activate).toHaveBeenCalledOnce();
    expect(existsSync(freshProfilePath)).toBe(true);
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
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "organization-existing"
        ? organizationProfilePath
        : originalResolveProfilePath(id),
    );
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
    expect(prepareProfile).toHaveBeenCalledWith(
      "Fresh Agent",
      null,
      "fresh-agent",
      "agent_projection",
    );
    expect(createProfile).not.toHaveBeenCalled();
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
    await vi.waitFor(() => {
      expect(recordDeliveryVerification).toHaveBeenCalledTimes(5);
    });
    expect(
      recordDeliveryVerification.mock.calls.map(
        ([receipt]) => receipt.verificationStatus,
      ),
    ).toEqual([
      "catalog_visible",
      "signature_verified",
      "compatible",
      "installed",
      "activated",
    ]);
    expect(recordDeliveryVerification.mock.calls[4]?.[0]).toMatchObject({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      releaseRevisionId: OFFICIAL_RELEASE_REVISION_ID,
      contentDigest: v1.content_digest,
      runtimeVersion: "v0.18.2-agentera.1",
      desktopVersion: "v0.7.4",
    });
  });

  it("does not roll back an official install when verification delivery is unavailable", async () => {
    policy = makeOfficialPolicy(v1);
    createInstallation.mockResolvedValueOnce({
      installation: pendingOfficialInstallation(),
      policy_snapshot: policy,
      replayed: false,
    });
    activateInstallation.mockResolvedValueOnce(
      pendingOfficialInstallation("active"),
    );
    recordDeliveryVerification.mockRejectedValue(
      new Error("cloud unavailable"),
    );

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
    ).resolves.toMatchObject({ status: "active" });
    await vi.waitFor(() =>
      expect(recordDeliveryVerification).toHaveBeenCalled(),
    );
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'official_delivery_verification'",
        )
        .get(),
    ).toEqual({ count: 5 });
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
    expect(prepareProfile).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
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
      .mockImplementationOnce(async () => {
        await Promise.resolve();
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
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "existing" ? claimed : originalResolveProfilePath(id),
    );
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

  // @lat: [[lat.md/agentera-agent-control-plane#AgentEra Agent control plane V1#Installation and binding#Canonical Profile target validation]]
  it("claims the default Profile through the production installation path", async () => {
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "default" ? profilesRoot : originalResolveProfilePath(id),
    );

    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: {
        kind: "claim",
        profileId: "default",
        profilePath: profilesRoot,
      },
    });

    expect(installed).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      status: "active",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
    expect(createProfile).not.toHaveBeenCalled();
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(bindings.verifyProfileBinding(profilesRoot, owner)).toMatchObject({
      agentInstallationId: AGENT_INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
  });

  // @lat: [[lat.md/agentera-agent-control-plane#AgentEra Agent control plane V1#Installation and binding#Canonical Profile target validation]]
  it("rejects a mismatched default Profile path before Cloud mutation", async () => {
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "default" ? profilesRoot : originalResolveProfilePath(id),
    );

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: {
          kind: "claim",
          profileId: "default",
          profilePath: join(root, "not-the-hermes-home"),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_installation_request" });
    expect(createInstallation).not.toHaveBeenCalled();
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
    const pendingIntent = database.sqlite
      .prepare(
        "SELECT payload_json FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
      )
      .get() as { payload_json: string };
    expect(JSON.parse(pendingIntent.payload_json)).toMatchObject({
      profile_target: {
        kind: "fresh",
        profile_id: "fresh-agent",
        display_name: "Fresh Agent",
        model_source_profile_id: null,
        model_source_model_id: null,
      },
    });
    expect(pendingIntent.payload_json).not.toContain(freshProfilePath);

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

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Atomic fresh Profile allocation#Pending intent exclusion]]
  it("atomically allocates distinct Profile IDs for concurrent same-name creation intents", async () => {
    const rejectCreations: Array<(reason?: unknown) => void> = [];
    profileIdForAgentName.mockImplementation((name) =>
      name === "Fresh Agent 2" ? "fresh-agent-2" : "fresh-agent",
    );
    createInstallation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreations.push(reject);
        }),
    );

    const first = manager(owner, () => OPERATION_ID).install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const second = manager(owner, () => SECOND_OPERATION_ID).install({
      definitionId: SECOND_DEFINITION_ID,
      versionId: SECOND_VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const settled = Promise.allSettled([first, second]);

    expect(rejectCreations).toHaveLength(2);
    const profileIds = (
      database.sqlite
        .prepare(
          `SELECT payload_json FROM pending_sanitized_records
           WHERE record_type = 'agent_installation_create'`,
        )
        .all() as Array<{ payload_json: string }>
    )
      .map((row) => {
        const payload = JSON.parse(row.payload_json) as {
          profile_target: { profile_id: string };
        };
        return payload.profile_target.profile_id;
      })
      .sort();

    for (const reject of rejectCreations) {
      reject(new Error("injected concurrent creation pause"));
    }
    expect(await settled).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "creation_failed" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "creation_failed" }),
      }),
    ]);
    expect(profileIds).toEqual(["fresh-agent", "fresh-agent-2"]);
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Atomic fresh Profile allocation#Operation handoff exclusion]]
  it("keeps an operation-reserved Profile ID unavailable to a concurrent same-name intent", async () => {
    const rejectVersions: Array<(reason?: unknown) => void> = [];
    profileIdForAgentName.mockImplementation((name) =>
      name === "Fresh Agent 2" ? "fresh-agent-2" : "fresh-agent",
    );
    getVersion.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectVersions.push(reject);
        }),
    );

    const first = manager(owner, () => OPERATION_ID).install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    await vi.waitFor(() => expect(rejectVersions).toHaveLength(1));
    expect(
      database.sqlite
        .prepare(
          `SELECT target_profile_id, phase FROM installation_operations
           WHERE operation_id = ?`,
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ target_profile_id: "fresh-agent", phase: "prepared" });

    const rejectCreations: Array<(reason?: unknown) => void> = [];
    createInstallation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreations.push(reject);
        }),
    );
    const second = manager(owner, () => SECOND_OPERATION_ID).install({
      definitionId: SECOND_DEFINITION_ID,
      versionId: SECOND_VERSION_ID,
      profile: { kind: "fresh", name: "Fresh Agent" },
    });
    const settled = Promise.allSettled([first, second]);
    expect(rejectCreations).toHaveLength(1);
    const pendingIntent = database.sqlite
      .prepare(
        `SELECT payload_json FROM pending_sanitized_records
         WHERE record_type = 'agent_installation_create'`,
      )
      .get() as { payload_json: string };
    const profileId = (
      JSON.parse(pendingIntent.payload_json) as {
        profile_target: { profile_id: string };
      }
    ).profile_target.profile_id;

    for (const reject of rejectVersions) {
      reject(new Error("injected materialization pause"));
    }
    for (const reject of rejectCreations) {
      reject(new Error("injected concurrent creation pause"));
    }
    expect(await settled).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "materialization_failed" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "creation_failed" }),
      }),
    ]);
    expect(profileId).toBe("fresh-agent-2");
  });

  it("cold-restarts after Cloud creation succeeds before the local Installation journal", async () => {
    database.sqlite.exec(`
      CREATE TRIGGER injected_local_installation_insert_failure
      BEFORE INSERT ON local_agent_installations
      BEGIN
        SELECT RAISE(ABORT, 'injected local Installation insert failure');
      END;
    `);

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "installation_conflict" });
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
        )
        .get(),
    ).toEqual({ count: 1 });

    database.sqlite.exec(
      "DROP TRIGGER injected_local_installation_insert_failure",
    );
    const recovered =
      await coldRestartManager().reconcilePendingInstallations();

    expect(recovered).toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        runtimeProfileId: RUNTIME_PROFILE_ID,
        status: "active",
      }),
    ]);
    expect(createInstallation).toHaveBeenCalledTimes(2);
    expect(createInstallation.mock.calls[0][1]).toBe(OPERATION_ID);
    expect(createInstallation.mock.calls[1][1]).toBe(OPERATION_ID);
    expect(prepareProfile).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  // @lat: [[lat.md/agentera-agent-control-plane#Installation and binding#Installation reconciliation isolation#Legacy creation intent migration]]
  it("migrates a legacy creation intent into an explicit pending Profile retry", async () => {
    database.sqlite
      .prepare(
        `INSERT INTO pending_sanitized_records (
           id, tenant_id, owner_id, device_installation_id,
           record_type, payload_json, attempt_count, next_attempt_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'agent_installation_create', ?, 0, NULL, ?, ?)`,
      )
      .run(
        OPERATION_ID,
        owner.tenantId,
        owner.ownerId,
        owner.deviceInstallationId,
        JSON.stringify({
          definition_id: DEFINITION_ID,
          version_id: VERSION_ID,
          idempotency_key: OPERATION_ID,
          source_scope: "USER",
          source_workspace_id: null,
          source_organization_id: null,
        }),
        NOW.toISOString(),
        NOW.toISOString(),
      );

    const recovered =
      await coldRestartManager().reconcilePendingInstallations();

    expect(recovered).toEqual([
      expect.objectContaining({
        agentInstallationId: AGENT_INSTALLATION_ID,
        runtimeProfileId: null,
        status: "pending",
      }),
    ]);
    expect(createInstallation).toHaveBeenCalledWith(
      {
        definition_id: DEFINITION_ID,
        version_id: VERSION_ID,
      } satisfies CreateAgentInstallationRequest,
      OPERATION_ID,
    );
    expect(createProfile).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM pending_sanitized_records
           WHERE record_type = 'agent_installation_create'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(manager().getLocalInstallation(AGENT_INSTALLATION_ID)).toMatchObject(
      {
        runtimeProfileId: null,
        status: "pending",
      },
    );
  });

  it("rejects a different Profile target for an existing Cloud creation intent", async () => {
    createInstallation.mockRejectedValueOnce(new Error("response lost"));
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "creation_failed" });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Renamed Agent" },
      }),
    ).rejects.toMatchObject({ code: "installation_conflict" });
    expect(createInstallation).toHaveBeenCalledOnce();
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'agent_installation_create'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("reuses the exact persisted fresh Profile ID when local slug availability changes", async () => {
    createInstallation.mockRejectedValueOnce(new Error("response lost"));
    const request = {
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profile: { kind: "fresh" as const, name: "Fresh Agent" },
    };
    await expect(manager().install(request)).rejects.toMatchObject({
      code: "creation_failed",
    });
    profileIdForAgentName.mockReturnValue("fresh-agent-2");

    await expect(manager().install(request)).resolves.toMatchObject({
      runtimeProfileId: RUNTIME_PROFILE_ID,
      status: "active",
    });
    expect(createInstallation).toHaveBeenCalledTimes(2);
    expect(createInstallation.mock.calls[0][1]).toBe(OPERATION_ID);
    expect(createInstallation.mock.calls[1][1]).toBe(OPERATION_ID);
    expect(prepareProfile).toHaveBeenCalledWith(
      "Fresh Agent",
      null,
      "fresh-agent",
      "agent_projection",
    );
    expect(createProfile).not.toHaveBeenCalled();
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

  it.each([
    ["profile_bound", "prepared", "profile_binding_failed", 1],
    ["profile_attached", "profile_bound", "profile_binding_failed", 1],
    ["projection_active", "profile_attached", "profile_binding_failed", 1],
    ["cloud_activated", "projection_active", "activation_failed", 2],
  ] as const)(
    "cold-restarts after the durable %s edge without creating another Profile",
    async (failedPhase, retainedPhase, expectedCode, cloudActivationCalls) => {
      failJournalAdvanceTo(failedPhase);

      await expect(
        manager().install({
          definitionId: DEFINITION_ID,
          versionId: VERSION_ID,
          profile: { kind: "fresh", name: "Fresh Agent" },
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(
        database.sqlite
          .prepare(
            "SELECT phase FROM installation_operations WHERE operation_id = ?",
          )
          .get(AGENT_INSTALLATION_ID),
      ).toEqual({ phase: retainedPhase });

      clearJournalFailure();
      const recovered =
        await coldRestartManager().reconcilePendingInstallations();

      expect(recovered).toEqual([
        expect.objectContaining({
          agentInstallationId: AGENT_INSTALLATION_ID,
          runtimeProfileId: RUNTIME_PROFILE_ID,
          status: "active",
        }),
      ]);
      expect(prepareProfile).toHaveBeenCalledOnce();
      expect(createProfile).not.toHaveBeenCalled();
      expect(activateInstallation).toHaveBeenCalledTimes(cloudActivationCalls);
      expect(
        new Set(activateInstallation.mock.calls.map((call) => call[3])),
      ).toEqual(new Set([`agentera:activate:${AGENT_INSTALLATION_ID}`]));
      expect(
        database.sqlite
          .prepare(
            "SELECT phase FROM installation_operations WHERE operation_id = ?",
          )
          .get(AGENT_INSTALLATION_ID),
      ).toEqual({ phase: "committed" });
    },
  );

  it("commits Cloud success once after a crash before the local active transaction", async () => {
    database.sqlite.exec(`
      CREATE TRIGGER injected_local_active_failure
      BEFORE UPDATE OF status ON local_agent_installations
      WHEN NEW.status = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'injected local active failure');
      END;
    `);

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });
    expect(activateInstallation).toHaveBeenCalledOnce();
    expect(
      database.sqlite
        .prepare(
          "SELECT phase FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "cloud_activated" });

    database.sqlite.exec("DROP TRIGGER injected_local_active_failure");
    const recovered =
      await coldRestartManager().reconcilePendingInstallations();

    expect(recovered[0]).toMatchObject({ status: "active" });
    expect(activateInstallation).toHaveBeenCalledOnce();
    expect(
      database.sqlite
        .prepare(
          "SELECT phase FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({ phase: "committed" });
  });

  it("single-flights two concurrent reconciliation requests", async () => {
    activateInstallation.mockRejectedValueOnce(new Error("response lost"));
    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "activation_failed" });
    const restarted = coldRestartManager();

    const [first, second] = await Promise.all([
      restarted.reconcilePendingInstallations(),
      restarted.reconcilePendingInstallations(),
    ]);

    expect(first[0]).toMatchObject({ status: "active" });
    expect(second[0]).toMatchObject({ status: "active" });
    expect(prepareProfile).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
    expect(activateInstallation).toHaveBeenCalledTimes(2);
    expect(
      new Set(activateInstallation.mock.calls.map((call) => call[3])),
    ).toEqual(new Set([`agentera:activate:${AGENT_INSTALLATION_ID}`]));
  });

  it("marks a cross-owner claimed Profile as repair_required without reassigning it", async () => {
    const claimed = join(profilesRoot, "foreign-owned");
    mkdirSync(claimed, { recursive: true });
    bindings.bindExistingProfile(claimed, otherOwner);
    const originalResolveProfilePath = profiles.resolveProfilePath;
    profiles.resolveProfilePath = vi.fn((id: string) =>
      id === "foreign-owned" ? claimed : originalResolveProfilePath(id),
    );

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: {
          kind: "claim",
          profileId: "foreign-owned",
          profilePath: claimed,
        },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "profile_owner_conflict",
    });
    expect(bindings.verifyProfileBinding(claimed, otherOwner)).toMatchObject({
      ownerId: otherOwner.ownerId,
      agentInstallationId: null,
    });
    expect(() => bindings.verifyProfileBinding(claimed, owner)).toThrow(
      /another Aera owner/i,
    );
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("marks a foreign fresh-Profile reservation as repair_required without reclaiming it", async () => {
    const reservation = bindings.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Fresh Agent",
      owner: otherOwner,
      profileId: "fresh-agent",
      activate: false,
    });

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "profile_reservation_conflict",
    });
    expect(
      bindings.getFreshProfileReservation(AGENT_INSTALLATION_ID, otherOwner),
    ).toEqual(reservation);
    expect(createProfile).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("marks a reserved Runtime Profile ID collision as repair_required without deleting either Profile", async () => {
    bindings.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Fresh Agent",
      owner,
      profileId: "fresh-agent",
      activate: false,
    });
    const occupied = join(profilesRoot, "occupied");
    mkdirSync(occupied, { recursive: true });
    bindings.bindExistingProfile(occupied, owner);

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "runtime_profile_conflict",
    });
    expect(bindings.verifyProfileBinding(occupied, owner)).toMatchObject({
      runtimeProfileId: RUNTIME_PROFILE_ID,
      agentInstallationId: null,
    });
    expect(existsSync(freshProfilePath)).toBe(true);
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("marks unexpected private data in a reserved fresh Profile as repair_required without deleting it", async () => {
    mkdirSync(freshProfilePath, { recursive: true });
    writeFileSync(join(freshProfilePath, "MEMORY.md"), "private marker\n");

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "profile_private_data_conflict",
    });
    expect(readFileSync(join(freshProfilePath, "MEMORY.md"), "utf8")).toBe(
      "private marker\n",
    );
    expect(deleteProfile).not.toHaveBeenCalled();
    await expect(
      coldRestartManager().reconcilePendingInstallations(),
    ).resolves.toEqual([]);
    expect(prepareProfile).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("preserves an unknown reserved fresh Profile instead of taking it over", async () => {
    mkdirSync(freshProfilePath, { recursive: true });
    const unknownPath = join(freshProfilePath, "unexpected.json");
    writeFileSync(unknownPath, '{"private":true}\n');

    await expect(
      manager().install({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profile: { kind: "fresh", name: "Fresh Agent" },
      }),
    ).rejects.toMatchObject({ code: "profile_binding_failed" });

    expect(
      database.sqlite
        .prepare(
          "SELECT phase, retry_code FROM installation_operations WHERE operation_id = ?",
        )
        .get(AGENT_INSTALLATION_ID),
    ).toEqual({
      phase: "repair_required",
      retry_code: "profile_private_data_conflict",
    });
    expect(readFileSync(unknownPath, "utf8")).toBe('{"private":true}\n');
    expect(resetInterruptedFreshProfile).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
    expect(() =>
      bindings.verifyProfileBinding(freshProfilePath, owner),
    ).toThrow(/binding is required/i);
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
    expect(prepareProfile).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
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
