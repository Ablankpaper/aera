// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import type { HermesVersionProjection } from "./hermes-projection";
import {
  AgenteraHermesAdapter,
  AgenteraHermesAdapterError,
  digestToolPermissionDeclaration,
  type AgenteraHermesProfileBindings,
  type AgenteraHermesVerifiedCache,
} from "./hermes-adapter";
import { RuntimeBindingStore } from "./runtime-binding-store";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraAgentControlContext } from "../../shared/agentera-agent-control";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const DEFINITION_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_2_ID = "56565656-5656-4565-8565-565656565656";
const INSTALLATION_ID = "66666666-6666-4666-8666-666666666666";
const RUNTIME_PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const POLICY_ID = "88888888-8888-4888-8888-888888888888";
const POLICY_2_ID = "89898989-8989-4898-8989-898989898989";
const POLICY_3_ID = "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a";
const BINDING_ID = "99999999-9999-4999-8999-999999999999";
const ADAPTIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_2_ID = "abababab-abab-4bab-8bab-abababababab";
const ADAPTIVE_2_ID = "acacacac-acac-4cac-8cac-acacacacacac";
const BINDING_3_ID = "adadadad-adad-4dad-8dad-adadadadadae";
const ADAPTIVE_3_ID = "adadadad-adad-4dad-8dad-adadadadadaf";
const ORGANIZATION_ID = "adadadad-adad-4dad-8dad-adadadadadad";
const OFFICIAL_RELEASE_ID = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
const RELEASE_REVISION_1_ID = "afafafaf-afaf-4faf-8faf-afafafafafaf";
const RELEASE_REVISION_2_ID = "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0";
const RELEASE_REVISION_3_ID = "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2";
const NOW = new Date("2026-07-19T21:00:00.000Z");
const RUNTIME_VERSION = "v0.18.2-agentera.1";
const PROFILE_PATH = "/tmp/hermes-installed-agent-profile";
const VERSION_ROOT = `/tmp/agentera-control/versions/${VERSION_ID}`;
const BACKUP_ID = "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3";
const SOURCE_INSTALLATION_ID = "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4";
const PROFILE_LINEAGE_ID = "b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5";

const owner: AgenteraRuntimeOwner = {
  tenantId: TENANT_ID,
  ownerId: OWNER_ID,
  deviceInstallationId: DEVICE_ID,
};

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function version(): AgentVersion {
  return {
    id: VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 3,
    manifest: {
      schema_version: 1,
      identity: { system_prompt: "You are the signed research Agent." },
      assets: [
        {
          path: "skills/research/SKILL.md",
          kind: "skill",
          media_type: "text/markdown",
          sha256: "ab".repeat(32),
        },
        {
          path: "knowledge/base.md",
          kind: "knowledge",
          media_type: "text/markdown",
          sha256: "bc".repeat(32),
        },
      ],
      model_constraints: {
        allowed_models: ["gpt-5.6"],
        allowed_providers: ["openai"],
      },
      tools: { allowed: ["files.read"], denied: ["shell.root"] },
      dependencies: [],
      runtime_compatibility: { minimum_version: RUNTIME_VERSION },
    },
    bundle: {
      assets: [
        { path: "skills/research/SKILL.md", content: "# Research\n" },
        { path: "knowledge/base.md", content: "# Base\n" },
      ],
    },
    content_digest: "cd".repeat(32),
    signing_key_id: "agent-test-key",
    signature: "A".repeat(86),
    runtime_minimum_version: RUNTIME_VERSION,
    published_at: NOW.toISOString(),
  };
}

function policy(
  agentVersion = version(),
  policyId = POLICY_ID,
): AgentPolicySnapshot {
  return {
    id: policyId,
    installation_id: INSTALLATION_ID,
    agent_version_id: agentVersion.id,
    issuer: "http://127.0.0.1:8086",
    policy_version: 1,
    document: {
      schema_version: 1,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: agentVersion.id,
      version_digest: agentVersion.content_digest,
      model_constraints: agentVersion.manifest.model_constraints,
      runtime_compatibility: agentVersion.manifest.runtime_compatibility,
      tools: agentVersion.manifest.tools,
      deny_rules: ["no-secret-export"],
      publication_allowed: false,
    },
    content_digest: "de".repeat(32),
    signing_key_id: "policy-test-key",
    signature: "B".repeat(86),
    created_at: NOW.toISOString(),
  };
}

function officialPolicy(
  agentVersion: AgentVersion,
  policyId: string,
  releaseRevisionId: string,
): AgentPolicySnapshot {
  const value = policy(agentVersion, policyId);
  return {
    ...value,
    document: {
      ...value.document,
      official_context: {
        platform_id: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
        release_id: OFFICIAL_RELEASE_ID,
        release_revision_id: releaseRevisionId,
        user_id: OWNER_ID,
        device_installation_id: DEVICE_ID,
        installation_id: INSTALLATION_ID,
        product_scope: "USER",
        product_context_id: TENANT_ID,
      },
    },
  };
}

function projection(agentVersion = version()): HermesVersionProjection {
  return {
    agentInstallationId: INSTALLATION_ID,
    definitionId: DEFINITION_ID,
    versionId: agentVersion.id,
    versionNumber: agentVersion.version_number,
    contentDigest: agentVersion.content_digest,
    versionRoot: `/tmp/agentera-control/versions/${agentVersion.id}`,
    externalSkillsDirectory: `/tmp/agentera-control/${INSTALLATION_ID}/active/skills`,
    skills: [
      {
        originalName: "research",
        scopedName: "agentera.44444444.v3.research",
      },
    ],
  };
}

describe("AgentEra adapter around the real Hermes transport", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let bindingStore: RuntimeBindingStore;
  let cache: AgenteraHermesVerifiedCache;
  let profileBindings: AgenteraHermesProfileBindings;
  let getRuntimeVersion: ReturnType<typeof vi.fn<() => string>>;
  let getCurrentToolPermissionDigest: ReturnType<
    typeof vi.fn<
      (agentVersion: AgentVersion, snapshot: AgentPolicySnapshot) => string
    >
  >;
  let isVersionRevoked: ReturnType<
    typeof vi.fn<(versionId: string) => boolean>
  >;
  let assertEntitled: ReturnType<typeof vi.fn<() => void>>;
  let agentContext: AgenteraAgentControlContext;
  let materializeVersion: ReturnType<
    typeof vi.fn<
      (input: {
        agentInstallationId: string;
        version: AgentVersion;
      }) => HermesVersionProjection
    >
  >;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-hermes-adapter-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    database.sqlite
      .prepare(
        `INSERT INTO local_agent_installations (
           agent_installation_id, tenant_id, owner_id, device_installation_id,
           source_scope, source_workspace_id,
           update_policy,
           definition_id, selected_version_id,
           runtime_profile_id, policy_snapshot_id, status, retry_code,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'USER', NULL, 'manual', ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        INSTALLATION_ID,
        TENANT_ID,
        OWNER_ID,
        DEVICE_ID,
        DEFINITION_ID,
        VERSION_ID,
        RUNTIME_PROFILE_ID,
        POLICY_ID,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    const ids = [
      BINDING_ID,
      ADAPTIVE_ID,
      BINDING_2_ID,
      ADAPTIVE_2_ID,
      BINDING_3_ID,
      ADAPTIVE_3_ID,
    ];
    bindingStore = new RuntimeBindingStore({
      database,
      owner,
      now: () => NOW,
      randomUUID: () => ids.shift() ?? ADAPTIVE_ID,
    });
    const agentVersion = version();
    const snapshot = policy(agentVersion);
    cache = {
      getVerifiedVersion: vi.fn(() => agentVersion),
      getVerifiedPolicySnapshot: vi.fn(() => snapshot),
    };
    profileBindings = {
      verifyProfileBinding: vi.fn<
        AgenteraHermesProfileBindings["verifyProfileBinding"]
      >(() => ({
        tenantId: TENANT_ID,
        ownerScope: "USER",
        ownerId: OWNER_ID,
        deviceInstallationId: DEVICE_ID,
        agentInstallationId: INSTALLATION_ID,
        runtimeProfileId: RUNTIME_PROFILE_ID,
        boundAt: NOW.toISOString(),
      })),
    };
    getRuntimeVersion = vi.fn(() => RUNTIME_VERSION);
    getCurrentToolPermissionDigest = vi.fn((v, p) =>
      digestToolPermissionDeclaration(v, p),
    );
    isVersionRevoked = vi.fn(() => false);
    assertEntitled = vi.fn();
    agentContext = { scope: "USER" };
    materializeVersion = vi.fn(() => projection(agentVersion));
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function adapter(
    mode: "local" | "remote" | "ssh" = "local",
  ): AgenteraHermesAdapter {
    return new AgenteraHermesAdapter({
      database,
      bindingStore,
      profileBindings,
      cache,
      projection: { materializeVersion },
      getConnectionMode: () => mode,
      getRuntimeVersion,
      getCurrentToolPermissionDigest,
      isVersionRevoked,
      assertEntitled,
      getAgentContext: () => agentContext,
    });
  }

  it("freezes one published base, Profile, Runtime, policy and session across turns", async () => {
    const subject = adapter();
    const first = await subject.prepareInstalledTurn({
      conversationKey: "run-agent-1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(first.profilePath).toBe(PROFILE_PATH);
    expect(first.resumeSessionId).toBeUndefined();
    expect(first.envelope.requireBoundApiTransport).toBe(true);
    expect(first.binding).toMatchObject({
      id: BINDING_ID,
      agentVersionId: VERSION_ID,
      policySnapshotId: POLICY_ID,
      officialReleaseRevisionId: null,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      runtimeVersion: RUNTIME_VERSION,
      toolPermissionDigest: digestToolPermissionDeclaration(
        version(),
        policy(),
      ),
      publishedBaseDigest: version().content_digest,
    });
    expect(first.envelope.instructions).toContain(
      "You are the signed research Agent.",
    );
    expect(first.envelope.instructions).toContain(VERSION_ID);
    expect(first.envelope.instructions).toContain(POLICY_ID);
    expect(first.envelope.instructions).toContain(
      `${VERSION_ROOT}/assets/knowledge/base.md`,
    );
    expect(first.envelope.instructions).toContain(
      "Profile-local SOUL and Skills take precedence",
    );
    expect(first.envelope.instructions).not.toContain("MEMORY.md");
    expect(first.envelope.instructions).not.toContain("USER.md");

    subject.attachHermesSession(first.binding.id, "desk-original-session");
    const second = await subject.prepareInstalledTurn({
      conversationKey: "run-agent-1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: "desk-original-session",
    });
    expect(second.binding).toEqual({
      ...first.binding,
      hermesSessionId: "desk-original-session",
    });
    expect(second.resumeSessionId).toBe("desk-original-session");
    expect(second.envelope).toEqual(first.envelope);
    expect(cache.getVerifiedVersion).toHaveBeenCalledTimes(2);
    expect(cache.getVerifiedPolicySnapshot).toHaveBeenCalledTimes(2);
    expect(assertEntitled).toHaveBeenCalledTimes(2);
  });

  it("pins each official release revision so v1, v2, and rollback conversations remain immutable", async () => {
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET source_scope = 'PLATFORM', source_workspace_id = NULL,
             source_organization_id = NULL, official_release_id = ?,
             selected_release_revision_id = ?, update_policy = 'managed'
         WHERE agent_installation_id = ?`,
      )
      .run(OFFICIAL_RELEASE_ID, RELEASE_REVISION_1_ID, INSTALLATION_ID);
    const firstVersion = version();
    const nextVersion: AgentVersion = {
      ...firstVersion,
      id: VERSION_2_ID,
      version_number: 4,
      content_digest: "ef".repeat(32),
    };
    const firstPolicy = officialPolicy(
      firstVersion,
      POLICY_ID,
      RELEASE_REVISION_1_ID,
    );
    const nextPolicy = officialPolicy(
      nextVersion,
      POLICY_2_ID,
      RELEASE_REVISION_2_ID,
    );
    const rollbackPolicy = officialPolicy(
      firstVersion,
      POLICY_3_ID,
      RELEASE_REVISION_3_ID,
    );
    vi.mocked(cache.getVerifiedVersion).mockImplementation((versionId) =>
      versionId === VERSION_2_ID ? nextVersion : firstVersion,
    );
    vi.mocked(cache.getVerifiedPolicySnapshot).mockImplementation(
      (versionId, policyId) =>
        policyId === POLICY_3_ID
          ? rollbackPolicy
          : versionId === VERSION_2_ID
            ? nextPolicy
            : firstPolicy,
    );
    materializeVersion.mockImplementation(({ version: candidate }) =>
      projection(candidate),
    );
    const subject = adapter();

    const v1Turn = await subject.prepareInstalledTurn({
      conversationKey: "official-v1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET selected_version_id = ?, policy_snapshot_id = ?,
             selected_release_revision_id = ?
         WHERE agent_installation_id = ?`,
      )
      .run(VERSION_2_ID, POLICY_2_ID, RELEASE_REVISION_2_ID, INSTALLATION_ID);
    const v2Turn = await subject.prepareInstalledTurn({
      conversationKey: "official-v2",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    const resumedV1 = await subject.prepareInstalledTurn({
      conversationKey: "official-v1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET selected_version_id = ?, policy_snapshot_id = ?,
             selected_release_revision_id = ?
         WHERE agent_installation_id = ?`,
      )
      .run(VERSION_ID, POLICY_3_ID, RELEASE_REVISION_3_ID, INSTALLATION_ID);
    const rollbackTurn = await subject.prepareInstalledTurn({
      conversationKey: "official-rollback-v1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    const resumedV2 = await subject.prepareInstalledTurn({
      conversationKey: "official-v2",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(v1Turn.binding).toMatchObject({
      agentVersionId: VERSION_ID,
      officialReleaseRevisionId: RELEASE_REVISION_1_ID,
    });
    expect(v2Turn.binding).toMatchObject({
      agentVersionId: VERSION_2_ID,
      officialReleaseRevisionId: RELEASE_REVISION_2_ID,
    });
    expect(resumedV1.binding).toEqual(v1Turn.binding);
    expect(rollbackTurn.binding).toMatchObject({
      agentVersionId: VERSION_ID,
      policySnapshotId: POLICY_3_ID,
      officialReleaseRevisionId: RELEASE_REVISION_3_ID,
    });
    expect(resumedV2.binding).toEqual(v2Turn.binding);
    expect(
      bindingStore.listPendingCloudRecords().map((record) => record.body),
    ).toEqual([
      expect.objectContaining({
        agent_version_id: VERSION_ID,
        official_release_revision_id: RELEASE_REVISION_1_ID,
      }),
      expect.objectContaining({
        agent_version_id: VERSION_2_ID,
        official_release_revision_id: RELEASE_REVISION_2_ID,
      }),
      expect.objectContaining({
        agent_version_id: VERSION_ID,
        official_release_revision_id: RELEASE_REVISION_3_ID,
      }),
    ]);
  });

  it("keeps Organization-sourced conversations USER-owned and freezes an active conversation across version selection", async () => {
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET source_scope = 'ORGANIZATION', source_workspace_id = NULL,
             source_organization_id = ?
         WHERE agent_installation_id = ?`,
      )
      .run(ORGANIZATION_ID, INSTALLATION_ID);
    agentContext = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "member",
    };
    const firstVersion = version();
    const nextVersion: AgentVersion = {
      ...firstVersion,
      id: VERSION_2_ID,
      version_number: 4,
      content_digest: "ef".repeat(32),
    };
    const firstPolicy = policy(firstVersion);
    const nextPolicy = policy(nextVersion, POLICY_2_ID);
    vi.mocked(cache.getVerifiedVersion).mockImplementation((versionId) =>
      versionId === VERSION_2_ID ? nextVersion : firstVersion,
    );
    vi.mocked(cache.getVerifiedPolicySnapshot).mockImplementation(
      (versionId) => (versionId === VERSION_2_ID ? nextPolicy : firstPolicy),
    );
    materializeVersion.mockImplementation(({ version: candidate }) =>
      projection(candidate),
    );
    const subject = adapter();

    const first = await subject.prepareInstalledTurn({
      conversationKey: "organization-conversation-a",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET selected_version_id = ?, policy_snapshot_id = ?
         WHERE agent_installation_id = ?`,
      )
      .run(VERSION_2_ID, POLICY_2_ID, INSTALLATION_ID);

    const resumed = await subject.prepareInstalledTurn({
      conversationKey: "organization-conversation-a",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    agentContext = { scope: "USER" };
    const resumedAfterRemoval = await subject.prepareInstalledTurn({
      conversationKey: "organization-conversation-a",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    agentContext = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "member",
    };
    const second = await subject.prepareInstalledTurn({
      conversationKey: "organization-conversation-b",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(first.binding.ownerScope).toBe("USER");
    expect(resumed.binding.agentVersionId).toBe(first.binding.agentVersionId);
    expect(resumed.binding.policySnapshotId).toBe(
      first.binding.policySnapshotId,
    );
    expect(resumedAfterRemoval.binding.id).toBe(first.binding.id);
    expect(second.binding).toMatchObject({
      ownerScope: "USER",
      agentVersionId: VERSION_2_ID,
      policySnapshotId: POLICY_2_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
    const cloudOutbox = JSON.stringify(bindingStore.listPendingCloudRecords());
    expect(cloudOutbox).not.toContain(ORGANIZATION_ID);
    expect(cloudOutbox).not.toMatch(/organization|owner_scope|conversation/i);
  });

  it("blocks a new Organization-sourced conversation after trusted membership context is removed", async () => {
    database.sqlite
      .prepare(
        `UPDATE local_agent_installations
         SET source_scope = 'ORGANIZATION', source_workspace_id = NULL,
             source_organization_id = ?
         WHERE agent_installation_id = ?`,
      )
      .run(ORGANIZATION_ID, INSTALLATION_ID);
    agentContext = { scope: "USER" };
    const subject = adapter();

    await expect(
      subject.prepareInstalledTurn({
        conversationKey: "organization-after-removal",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
        code: "organization_agent_forbidden",
      }),
    );
    expect(
      bindingStore.getByConversationKey("organization-after-removal"),
    ).toBeNull();
    expect(cache.getVerifiedVersion).not.toHaveBeenCalled();
  });

  it("rechecks immutable cached bytes on every turn and fails before Hermes when they become invalid", async () => {
    const subject = adapter();
    await subject.prepareInstalledTurn({
      conversationKey: "run-agent-cache",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    vi.mocked(cache.getVerifiedVersion).mockImplementation(() => {
      throw new Error("cache_corrupt");
    });

    await expect(
      subject.prepareInstalledTurn({
        conversationKey: "run-agent-cache",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
        code: "version_invalid",
      }),
    );
  });

  it("keeps restored historical sessions read-only when no verified RuntimeBinding was imported", async () => {
    database.sqlite
      .prepare(
        `INSERT INTO encrypted_backup_restores (
           backup_id, tenant_id, owner_id, device_installation_id,
           source_installation_id, agent_installation_id,
           runtime_profile_id, profile_lineage_id,
           encrypted_runtime_binding_provenance,
           historical_sessions_read_only, restored_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        BACKUP_ID,
        TENANT_ID,
        OWNER_ID,
        DEVICE_ID,
        SOURCE_INSTALLATION_ID,
        INSTALLATION_ID,
        RUNTIME_PROFILE_ID,
        PROFILE_LINEAGE_ID,
        Buffer.from("encrypted unavailable historical binding"),
        NOW.toISOString(),
      );

    await expect(
      adapter().prepareInstalledTurn({
        conversationKey: "restored-history",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: "historical-session-without-runtime",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
        code: "binding_required",
      }),
    );
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite
        .prepare(
          `SELECT historical_sessions_read_only
           FROM encrypted_backup_restores WHERE backup_id = ?`,
        )
        .get(BACKUP_ID),
    ).toEqual({ historical_sessions_read_only: 1 });
  });

  it.each([
    ["runtime_drift", () => getRuntimeVersion.mockReturnValue("v0.18.3")],
    [
      "tool_policy_drift",
      () => getCurrentToolPermissionDigest.mockReturnValue("ef".repeat(32)),
    ],
    ["version_revoked", () => isVersionRevoked.mockReturnValue(true)],
  ] as const)("fails closed on %s", async (code, mutate) => {
    const subject = adapter();
    const prepared = await subject.prepareInstalledTurn({
      conversationKey: `run-${code}`,
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    subject.attachHermesSession(prepared.binding.id, `desk-${code}`);
    mutate();

    await expect(
      subject.prepareInstalledTurn({
        conversationKey: `run-${code}`,
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: `desk-${code}`,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({ code }),
    );
  });

  it.each(["remote", "ssh"] as const)(
    "rejects the installed-Agent path in %s mode without changing legacy chat",
    async (mode) => {
      await expect(
        adapter(mode).prepareInstalledTurn({
          conversationKey: `run-${mode}`,
          profilePath: PROFILE_PATH,
          owner,
          resumeSessionId: null,
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
          code: "local_runtime_required",
        }),
      );
      expect(cache.getVerifiedVersion).not.toHaveBeenCalled();
    },
  );
});
