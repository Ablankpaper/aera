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
import { join } from "node:path";
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
const NOW = new Date("2026-07-19T19:30:00.000Z");
const ORIGIN = "http://127.0.0.1:8086";
const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORGANIZATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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
  let getPolicySnapshot: Mock<AgentInstallationClient["getPolicySnapshot"]>;
  let activateInstallation: Mock<
    AgentInstallationClient["activateInstallation"]
  >;
  let selectInstallationVersion: Mock<
    AgentInstallationClient["selectInstallationVersion"]
  >;
  let archiveInstallation: Mock<AgentInstallationClient["archiveInstallation"]>;
  let materializeVersion: Mock<
    AgentInstallationProjection["materializeVersion"]
  >;
  let activateForProfile: Mock<
    AgentInstallationProjection["activateForProfile"]
  >;
  let createProfile: Mock<AgentInstallationProfileAdapter["createProfile"]>;
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
    client = {
      origin: ORIGIN,
      createInstallation,
      getVersion,
      getPolicySnapshot,
      activateInstallation,
      selectInstallationVersion,
      archiveInstallation,
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
    profiles = {
      createProfile,
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
      "profile:activate:fresh-agent",
      `profile:project:${VERSION_ID}`,
      "cloud:activate",
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
    const installed = await manager().install({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      },
      profile: { kind: "fresh", name: "Fresh Agent" },
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
