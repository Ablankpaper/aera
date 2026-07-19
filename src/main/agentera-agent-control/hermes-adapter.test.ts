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

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const DEFINITION_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const INSTALLATION_ID = "66666666-6666-4666-8666-666666666666";
const RUNTIME_PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const POLICY_ID = "88888888-8888-4888-8888-888888888888";
const BINDING_ID = "99999999-9999-4999-8999-999999999999";
const ADAPTIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-07-19T21:00:00.000Z");
const RUNTIME_VERSION = "v0.18.2-agentera.1";
const PROFILE_PATH = "/tmp/hermes-installed-agent-profile";
const VERSION_ROOT = `/tmp/agentera-control/versions/${VERSION_ID}`;

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

function policy(agentVersion = version()): AgentPolicySnapshot {
  return {
    id: POLICY_ID,
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

function projection(agentVersion = version()): HermesVersionProjection {
  return {
    agentInstallationId: INSTALLATION_ID,
    definitionId: DEFINITION_ID,
    versionId: VERSION_ID,
    versionNumber: 3,
    contentDigest: agentVersion.content_digest,
    versionRoot: VERSION_ROOT,
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
           agent_installation_id, definition_id, selected_version_id,
           runtime_profile_id, policy_snapshot_id, status, retry_code,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        INSTALLATION_ID,
        DEFINITION_ID,
        VERSION_ID,
        RUNTIME_PROFILE_ID,
        POLICY_ID,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    const ids = [BINDING_ID, ADAPTIVE_ID];
    bindingStore = new RuntimeBindingStore({
      database,
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
