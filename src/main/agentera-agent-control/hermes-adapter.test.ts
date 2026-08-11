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
import {
  CapabilityBindingStore,
  type LocalMcpCapabilityServer,
} from "./capability-binding-store";
import { RuntimeBindingStore } from "./runtime-binding-store";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraAgentControlContext } from "../../shared/agentera-agent-control";
import type { SessionModelOverride } from "../../shared/model-override";
import { freezeResolvedOwnerModelRoute } from "./frozen-agent-model-route";
import type { ResolvedOwnerModelRoute } from "./owner-model-route-catalog";

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

const OPENAI_ROUTE: ResolvedOwnerModelRoute = {
  id: "account-home\0openai-gpt",
  sourceProfileId: "account-home",
  modelLibraryId: "openai-gpt",
  provider: "openai",
  providerLabel: "OpenAI",
  model: "gpt-5.6",
  displayName: "GPT-5.6",
  baseUrl: "",
  apiMode: "responses",
  credentialRef: "OPENAI_API_KEY",
  credentialAvailable: true,
};

const PETOI_ROUTE: ResolvedOwnerModelRoute = {
  id: "account-home\0petoi-gpt",
  sourceProfileId: "account-home",
  modelLibraryId: "petoi-gpt",
  provider: "custom:petoi",
  providerLabel: "Petoi",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  baseUrl: "https://api.petoi.cn/v1",
  apiMode: "codex_responses",
  credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
  credentialAvailable: true,
};

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
  if (agentVersion.manifest.schema_version !== 1) {
    throw new Error("V1 policy fixture requires a V1 manifest");
  }
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

function versionV3(input: {
  required: boolean;
  logicalName?: string;
  localTool?: string;
}): AgentVersion {
  const base = version();
  const logicalName = input.logicalName ?? "private-docs";
  const localTool = input.localTool ?? "docs.read";
  return {
    ...base,
    manifest: {
      schema_version: 3,
      identity: base.manifest.identity,
      assets: base.manifest.assets,
      model_policy: {
        mode: "allowlist",
        allowed_models: ["gpt-5.6"],
        allowed_providers: ["openai"],
      },
      mcp_requirements: [
        {
          logical_name: logicalName,
          tools: [localTool],
          required: input.required,
          permission_reason: "Read approved private documents",
        },
      ],
      tools: { allowed: [localTool], denied: [] },
      dependencies: base.manifest.dependencies,
      runtime_compatibility: base.manifest.runtime_compatibility,
    },
    content_digest: "ce".repeat(32),
  };
}

function policyV3(agentVersion: AgentVersion): AgentPolicySnapshot {
  if (agentVersion.manifest.schema_version !== 3) {
    throw new Error("V3 policy fixture requires a V3 manifest");
  }
  return {
    id: POLICY_ID,
    installation_id: INSTALLATION_ID,
    agent_version_id: agentVersion.id,
    issuer: "http://127.0.0.1:8086",
    policy_version: 1,
    document: {
      schema_version: 3,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: agentVersion.id,
      version_digest: agentVersion.content_digest,
      model_policy: agentVersion.manifest.model_policy,
      mcp_requirements: agentVersion.manifest.mcp_requirements,
      runtime_compatibility: agentVersion.manifest.runtime_compatibility,
      tools: agentVersion.manifest.tools,
      deny_rules: ["no-secret-export"],
      publication_allowed: false,
    },
    content_digest: "df".repeat(32),
    signing_key_id: "policy-test-key",
    signature: "B".repeat(86),
    created_at: NOW.toISOString(),
  };
}

function versionV2(
  mode: "user_select" | "allowlist" | "fixed",
  allowedProviders: string[] = [],
  allowedModels: string[] = [],
): AgentVersion {
  const base = version();
  return {
    ...base,
    manifest: {
      schema_version: 2,
      identity: base.manifest.identity,
      assets: base.manifest.assets,
      model_policy: {
        mode,
        allowed_providers: allowedProviders,
        allowed_models: allowedModels,
      },
      tools: base.manifest.tools,
      dependencies: base.manifest.dependencies,
      runtime_compatibility: base.manifest.runtime_compatibility,
    },
    content_digest: "cf".repeat(32),
  };
}

function policyV2(agentVersion: AgentVersion): AgentPolicySnapshot {
  if (agentVersion.manifest.schema_version !== 2) {
    throw new Error("V2 policy fixture requires a V2 manifest");
  }
  return {
    id: POLICY_ID,
    installation_id: INSTALLATION_ID,
    agent_version_id: agentVersion.id,
    issuer: "http://127.0.0.1:8086",
    policy_version: 1,
    document: {
      schema_version: 2,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: agentVersion.id,
      version_digest: agentVersion.content_digest,
      model_policy: agentVersion.manifest.model_policy,
      runtime_compatibility: agentVersion.manifest.runtime_compatibility,
      tools: agentVersion.manifest.tools,
      deny_rules: ["no-secret-export"],
      publication_allowed: false,
    },
    content_digest: "e0".repeat(32),
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

describe("Aera adapter around the real Hermes transport", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let bindingStore: RuntimeBindingStore;
  let capabilityBindingStore: CapabilityBindingStore;
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
  let currentModelRoute: SessionModelOverride;
  let materializeVersion: ReturnType<
    typeof vi.fn<
      (input: {
        agentInstallationId: string;
        version: AgentVersion;
      }) => HermesVersionProjection
    >
  >;
  let profileMcpCapabilities: LocalMcpCapabilityServer[];
  let getProfileMcpCapabilities: ReturnType<
    typeof vi.fn<(profilePath: string) => LocalMcpCapabilityServer[]>
  >;
  let resolvedModelRoutes: ResolvedOwnerModelRoute[];
  let resolveCurrentModelRoute: ReturnType<
    typeof vi.fn<
      (
        sourceProfileId: string,
        modelLibraryId: string,
      ) => ResolvedOwnerModelRoute | null
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
    capabilityBindingStore = new CapabilityBindingStore({
      database,
      owner,
      now: () => NOW,
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
    currentModelRoute = {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "",
    };
    materializeVersion = vi.fn(() => projection(agentVersion));
    profileMcpCapabilities = [];
    getProfileMcpCapabilities = vi.fn(() => profileMcpCapabilities);
    resolvedModelRoutes = [OPENAI_ROUTE, PETOI_ROUTE];
    resolveCurrentModelRoute = vi.fn(
      (sourceProfileId, modelLibraryId) =>
        resolvedModelRoutes.find(
          (route) =>
            route.sourceProfileId === sourceProfileId &&
            route.modelLibraryId === modelLibraryId,
        ) ?? null,
    );
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
      capabilityBindingStore,
      profileBindings,
      cache,
      projection: { materializeVersion },
      getConnectionMode: () => mode,
      getRuntimeVersion,
      getCurrentToolPermissionDigest,
      getProfileModelConfig: () => currentModelRoute,
      resolveCurrentModelRoute,
      getProfileMcpCapabilities,
      isVersionRevoked,
      assertEntitled,
      getAgentContext: () => agentContext,
    });
  }

  it("validates an installed turn without persisting its RuntimeBinding", async () => {
    const subject = adapter();

    const plan = await subject.prepareInstalledTurnPlan({
      conversationKey: "run-agent-plan",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(bindingStore.getByConversationKey("run-agent-plan")).toBeNull();
    expect(bindingStore.listPendingCloudRecords()).toEqual([]);

    const binding = bindingStore.getOrCreateForConversation(plan.bindingInput);
    const prepared = subject.finalizeInstalledTurn(plan, binding);
    expect(prepared.binding).toEqual(binding);
    expect(prepared.profilePath).toBe(PROFILE_PATH);
    expect(prepared.resumeSessionId).toBeUndefined();
    expect(prepared.modelOverride).toEqual(currentModelRoute);
    expect(prepared.envelope.requireBoundApiTransport).toBe(true);
  });

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
    expect(first.modelOverride).toEqual(currentModelRoute);
    expect(first.binding).toMatchObject({
      id: BINDING_ID,
      agentVersionId: VERSION_ID,
      policySnapshotId: POLICY_ID,
      officialReleaseRevisionId: null,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      runtimeVersion: RUNTIME_VERSION,
      modelRoute: currentModelRoute,
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
      JSON.stringify(
        join(VERSION_ROOT, "assets", "knowledge", "base.md"),
      ).slice(1, -1),
    );
    expect(first.envelope.instructions).toContain(
      "Profile-local SOUL and Skills take precedence",
    );
    expect(first.envelope.instructions).not.toContain("MEMORY.md");
    expect(first.envelope.instructions).not.toContain("USER.md");

    subject.attachHermesSession(first.binding.id, "desk-original-session");
    currentModelRoute = {
      provider: "custom:changed-default",
      model: "changed-after-conversation-start",
      baseUrl: "https://changed.invalid/v1",
    };
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
    expect(second.modelOverride).toEqual(first.modelOverride);
    expect(cache.getVerifiedVersion).toHaveBeenCalledTimes(2);
    expect(cache.getVerifiedPolicySnapshot).toHaveBeenCalledTimes(2);
    expect(assertEntitled).toHaveBeenCalledTimes(2);
  });

  function useV3(agentVersion: AgentVersion): void {
    const snapshot = policyV3(agentVersion);
    vi.mocked(cache.getVerifiedVersion).mockReturnValue(agentVersion);
    vi.mocked(cache.getVerifiedPolicySnapshot).mockReturnValue(snapshot);
    materializeVersion.mockReturnValue(projection(agentVersion));
  }

  function useV2(
    agentVersion: AgentVersion,
    snapshot = policyV2(agentVersion),
  ): void {
    vi.mocked(cache.getVerifiedVersion).mockReturnValue(agentVersion);
    vi.mocked(cache.getVerifiedPolicySnapshot).mockReturnValue(snapshot);
    materializeVersion.mockReturnValue(projection(agentVersion));
  }

  it("accepts a Main-resolved requested route under user_select", async () => {
    useV2(versionV2("user_select"));

    const plan = await adapter().prepareInstalledTurnPlan({
      conversationKey: "requested-user-select",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: PETOI_ROUTE,
    });

    expect(plan.bindingInput.modelRoute).toEqual(
      freezeResolvedOwnerModelRoute(PETOI_ROUTE),
    );
    expect(plan.modelOverride).toEqual({
      provider: PETOI_ROUTE.provider,
      model: PETOI_ROUTE.model,
      baseUrl: PETOI_ROUTE.baseUrl,
    });
  });

  it("accepts the custom provider family under an allowlist", async () => {
    useV2(versionV2("allowlist", ["custom"], [PETOI_ROUTE.model]));

    const plan = await adapter().prepareInstalledTurnPlan({
      conversationKey: "requested-allowlist",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: PETOI_ROUTE,
    });

    expect(plan.bindingInput.modelRoute).toEqual(
      freezeResolvedOwnerModelRoute(PETOI_ROUTE),
    );
  });

  it("applies the effective tenant model policy after the Manifest policy", async () => {
    const agentVersion = versionV2("user_select");
    const baseTenantPolicy = policyV2(agentVersion);
    if (baseTenantPolicy.document.schema_version !== 2) {
      throw new Error("fixture mismatch");
    }
    const tenantPolicy: AgentPolicySnapshot = {
      ...baseTenantPolicy,
      document: {
        ...baseTenantPolicy.document,
        model_policy: {
          mode: "allowlist",
          allowed_providers: ["openai"],
          allowed_models: ["gpt-5.6"],
        },
      },
    };
    useV2(agentVersion, tenantPolicy);

    await expect(
      adapter().prepareInstalledTurnPlan({
        conversationKey: "tenant-policy-denied",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
        requestedModelRoute: PETOI_ROUTE,
      }),
    ).rejects.toMatchObject({ code: "model_switch_provider_denied" });
  });

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#Candidate route versus current segment]]
  it("rejects a requested route when the active Agent policy is fixed", async () => {
    useV2(versionV2("fixed", ["openai"], ["gpt-5.6"]));
    const subject = adapter();
    const first = await subject.prepareInstalledTurn({
      conversationKey: "fixed-policy-root",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: OPENAI_ROUTE,
    });

    await expect(
      subject.prepareInstalledTurnPlan({
        conversationKey:
          "aera-segment:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
        existingBinding: first.binding,
        requestedModelRoute: PETOI_ROUTE,
      }),
    ).rejects.toMatchObject({ code: "model_switch_fixed_policy" });
  });

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#Current full-route and legacy validation]]
  it("fails closed when a full frozen route loses its source model", async () => {
    useV2(versionV2("user_select"));
    const subject = adapter();
    await subject.prepareInstalledTurn({
      conversationKey: "full-route-source-drift",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: OPENAI_ROUTE,
    });
    resolvedModelRoutes = [];

    await expect(
      subject.prepareInstalledTurn({
        conversationKey: "full-route-source-drift",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toMatchObject({ code: "model_policy_drift" });
  });

  it("fails closed when a full frozen route loses its credential", async () => {
    useV2(versionV2("user_select"));
    const subject = adapter();
    await subject.prepareInstalledTurn({
      conversationKey: "full-route-credential-drift",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: OPENAI_ROUTE,
    });
    resolvedModelRoutes = [{ ...OPENAI_ROUTE, credentialAvailable: false }];

    await expect(
      subject.prepareInstalledTurn({
        conversationKey: "full-route-credential-drift",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toMatchObject({ code: "model_policy_drift" });
  });

  it("reuses the immutable binding when the requested full route is unchanged", async () => {
    useV2(versionV2("user_select"));
    const subject = adapter();
    const first = await subject.prepareInstalledTurn({
      conversationKey: "same-full-route",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      requestedModelRoute: OPENAI_ROUTE,
    });

    const plan = await subject.prepareInstalledTurnPlan({
      conversationKey:
        "aera-segment:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
      existingBinding: first.binding,
      requestedModelRoute: OPENAI_ROUTE,
    });
    const reused = bindingStore.getOrCreateForConversation(plan.bindingInput);

    expect(plan.bindingInput.conversationKey).toBe(
      first.binding.conversationKey,
    );
    expect(reused.id).toBe(first.binding.id);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("blocks a new V3 conversation when a required MCP requirement is not mapped", async () => {
    useV3(versionV3({ required: true }));

    await expect(
      adapter().prepareInstalledTurn({
        conversationKey: "required-mcp-missing",
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
        code: "profile_capability_configuration_required",
      }),
    );
    expect(
      bindingStore.getByConversationKey("required-mcp-missing"),
    ).toBeNull();
  });

  it.each([
    {
      name: "disabled server",
      servers: [
        { name: "employee-docs", enabled: false, tools: ["docs.read"] },
      ],
    },
    {
      name: "tool drift",
      servers: [
        { name: "employee-docs", enabled: true, tools: ["docs.search"] },
      ],
    },
  ])("blocks a required V3 requirement after $name", async ({ servers }) => {
    useV3(versionV3({ required: true }));
    capabilityBindingStore.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.read"],
      expectedRevision: null,
    });
    profileMcpCapabilities = servers;

    await expect(
      adapter().prepareInstalledTurn({
        conversationKey: `required-mcp-${servers[0]?.enabled ? "drift" : "disabled"}`,
        profilePath: PROFILE_PATH,
        owner,
        resumeSessionId: null,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgenteraHermesAdapterError>>({
        code: "profile_capability_configuration_required",
      }),
    );
  });

  it("allows an optional missing MCP requirement in a bounded degraded state", async () => {
    useV3(versionV3({ required: false, logicalName: "calendar-optional" }));

    const prepared = await adapter().prepareInstalledTurn({
      conversationKey: "optional-mcp-missing",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(prepared.binding.capabilityBindings).toEqual([]);
    expect(prepared.binding.degradedMcpRequirements).toEqual([
      "calendar-optional",
    ]);
    expect(prepared.envelope.instructions).toContain("calendar-optional");
  });

  it("uses a remap only for a new conversation and keeps the old frozen mapping", async () => {
    useV3(versionV3({ required: true }));
    const firstMapping = capabilityBindingStore.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs-v1",
      verifiedTools: ["docs.read"],
      expectedRevision: null,
    });
    profileMcpCapabilities = [
      { name: "employee-docs-v1", enabled: true, tools: ["docs.read"] },
    ];
    const subject = adapter();
    const first = await subject.prepareInstalledTurn({
      conversationKey: "mapped-mcp-v1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    capabilityBindingStore.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs-v2",
      verifiedTools: ["docs.read"],
      expectedRevision: firstMapping.revision,
    });
    profileMcpCapabilities = [
      { name: "employee-docs-v2", enabled: true, tools: ["docs.read"] },
    ];

    const resumed = await subject.prepareInstalledTurn({
      conversationKey: "mapped-mcp-v1",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    const next = await subject.prepareInstalledTurn({
      conversationKey: "mapped-mcp-v2",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(resumed.binding.capabilityBindings).toEqual(
      first.binding.capabilityBindings,
    );
    expect(resumed.binding.toolPermissionDigest).toBe(
      first.binding.toolPermissionDigest,
    );
    expect(next.binding.capabilityBindings).toEqual([
      {
        logicalName: "private-docs",
        localMcpName: "employee-docs-v2",
        tools: ["docs.read"],
        revision: 2,
      },
    ]);
    expect(next.binding.toolPermissionDigest).not.toBe(
      first.binding.toolPermissionDigest,
    );
    expect(next.envelope.instructions).toContain("employee-docs-v2");
    expect(next.envelope.instructions).not.toMatch(
      /https?:\/\/|command|args|env|header|token|auth/i,
    );
  });

  it("keeps a pre-model-route RuntimeBinding resumable", async () => {
    const subject = adapter();
    const first = await subject.prepareInstalledTurn({
      conversationKey: "legacy-model-route-conversation",
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });
    const legacy = { ...first.binding } as Partial<typeof first.binding>;
    delete legacy.modelRoute;
    database.sqlite
      .prepare("UPDATE runtime_bindings SET binding_json = ? WHERE id = ?")
      .run(JSON.stringify(legacy), first.binding.id);

    const resumed = await subject.prepareInstalledTurn({
      conversationKey: first.binding.conversationKey,
      profilePath: PROFILE_PATH,
      owner,
      resumeSessionId: null,
    });

    expect(resumed.binding.modelRoute).toBeNull();
    expect(resumed.modelOverride).toEqual(currentModelRoute);
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
