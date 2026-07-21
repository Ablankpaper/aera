// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";
import { AgenteraOrganizationPolicyVerificationError } from "./policy-verifier";
import {
  executeOrganizationIpc,
  parseAcceptOrganizationInvitationInput,
  parseCreateOrganizationDepartmentInput,
  parseCreateOrganizationInput,
  parseDissolveOrganizationInput,
  parseGetOrganizationPolicySnapshotInput,
  parseOrganizationAuditPageInput,
  parseOrganizationIDInput,
  parseOrganizationRevisionInput,
  parsePatchOrganizationMemberInput,
  parsePublishOrganizationPolicyInput,
  parseRemoveOrganizationMemberInput,
  parseRenameOrganizationDepartmentInput,
  parseRenameOrganizationInput,
  parseReviseOrganizationDepartmentInput,
  parseRevokeOrganizationInvitationInput,
  parseTransferOrganizationOwnerInput,
  serializeOrganizationAuditPage,
  serializeOrganizationCurrentPolicyState,
  serializeOrganizationInvitationCreation,
  serializeOrganizationPublicState,
} from "./ipc-contract";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const DEPARTMENT_ID = "30000000-0000-4000-8000-000000000001";
const INVITATION_ID = "40000000-0000-4000-8000-000000000001";
const POLICY_ID = "50000000-0000-4000-8000-000000000001";
const AUDIT_ID = "60000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const SIGNATURE = "A".repeat(86);
const CREATED_AT = "2026-07-21T00:00:00Z";
const DIGEST = "a".repeat(64);
const ROOT = join(__dirname, "../../..");

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const policyDocument = {
  schemaVersion: 1 as const,
  models: { allowlist: [{ provider: "openai", model: "gpt-5.6" }] },
  tools: { allowlist: ["browser"] },
  experienceCandidates: { mode: "manual_review" as const },
  officialAgents: { installation: "allowed" as const },
};

describe("AgentEra Organization IPC contract", () => {
  it("parses exact low- and high-risk Organization inputs", () => {
    expect(
      parseOrganizationIDInput({ organizationId: ORGANIZATION_ID }),
    ).toEqual({ organizationId: ORGANIZATION_ID });
    expect(
      parseCreateOrganizationInput({ displayName: "AgentEra Inc" }),
    ).toEqual({ displayName: "AgentEra Inc" });
    expect(
      parseRenameOrganizationInput({
        organizationId: ORGANIZATION_ID,
        displayName: "AgentEra Labs",
        expectedRevision: 2,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      displayName: "AgentEra Labs",
      expectedRevision: 2,
    });
    expect(
      parseOrganizationRevisionInput({
        organizationId: ORGANIZATION_ID,
        expectedRevision: 3,
      }),
    ).toEqual({ organizationId: ORGANIZATION_ID, expectedRevision: 3 });
    expect(
      parseTransferOrganizationOwnerInput({
        organizationId: ORGANIZATION_ID,
        targetUserId: USER_ID,
        expectedOrganizationRevision: 4,
        expectedOwnerRevision: 5,
        expectedTargetRevision: 6,
        confirmation: "transfer-organization-owner",
      }),
    ).toMatchObject({ confirmation: "transfer-organization-owner" });
    expect(
      parseDissolveOrganizationInput({
        organizationId: ORGANIZATION_ID,
        displayName: "AgentEra Labs",
        expectedRevision: 7,
        confirmation: "dissolve-organization",
      }),
    ).toMatchObject({ confirmation: "dissolve-organization" });
    expect(
      parsePatchOrganizationMemberInput({
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        patch: {
          role: "auditor",
          departmentId: DEPARTMENT_ID,
          expectedRevision: 2,
        },
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      patch: {
        role: "auditor",
        departmentId: DEPARTMENT_ID,
        expectedRevision: 2,
      },
    });
    expect(
      parseRemoveOrganizationMemberInput({
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        expectedRevision: 2,
      }),
    ).toMatchObject({ userId: USER_ID });
    expect(
      parseCreateOrganizationDepartmentInput({
        organizationId: ORGANIZATION_ID,
        displayName: "Research",
      }),
    ).toMatchObject({ displayName: "Research" });
    expect(
      parseRenameOrganizationDepartmentInput({
        organizationId: ORGANIZATION_ID,
        departmentId: DEPARTMENT_ID,
        displayName: "Applied Research",
        expectedRevision: 2,
      }),
    ).toMatchObject({ departmentId: DEPARTMENT_ID });
    expect(
      parseReviseOrganizationDepartmentInput({
        organizationId: ORGANIZATION_ID,
        departmentId: DEPARTMENT_ID,
        expectedRevision: 2,
      }),
    ).toMatchObject({ departmentId: DEPARTMENT_ID });
    expect(
      parseRevokeOrganizationInvitationInput({
        organizationId: ORGANIZATION_ID,
        invitationId: INVITATION_ID,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      invitationId: INVITATION_ID,
    });
    expect(parseAcceptOrganizationInvitationInput({ token: TOKEN })).toEqual({
      token: TOKEN,
    });
    expect(
      parsePublishOrganizationPolicyInput({
        organizationId: ORGANIZATION_ID,
        document: policyDocument,
        expectedOrganizationRevision: 2,
        expectedPolicyVersion: 2,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      document: policyDocument,
      expectedOrganizationRevision: 2,
      expectedPolicyVersion: 2,
    });
    expect(
      parseGetOrganizationPolicySnapshotInput({
        organizationId: ORGANIZATION_ID,
        policySnapshotId: POLICY_ID,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      policySnapshotId: POLICY_ID,
    });
    expect(
      parseOrganizationAuditPageInput({
        organizationId: ORGANIZATION_ID,
        limit: 50,
        cursor: TOKEN,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      page: { limit: 50, cursor: TOKEN },
    });
  });

  it.each([
    null,
    {},
    { organizationId: ORGANIZATION_ID, actorId: USER_ID },
    { organizationId: ORGANIZATION_ID, role: "owner" },
    { organizationId: ORGANIZATION_ID, cloudOrigin: "https://bad.invalid" },
    { organizationId: ORGANIZATION_ID, profilePath: "/private/profile" },
    { organizationId: ORGANIZATION_ID, runtimeBindingId: USER_ID },
  ])("rejects authority and runtime fields %#", (value) => {
    expect(() => parseOrganizationIDInput(value)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("rejects invalid revisions, roles, confirmations, policy enums, and page fields", () => {
    expect(() =>
      parseOrganizationRevisionInput({
        organizationId: ORGANIZATION_ID,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      parsePatchOrganizationMemberInput({
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        patch: { role: "owner", expectedRevision: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseTransferOrganizationOwnerInput({
        organizationId: ORGANIZATION_ID,
        targetUserId: USER_ID,
        expectedOrganizationRevision: 1,
        expectedOwnerRevision: 1,
        expectedTargetRevision: 1,
        confirmation: "yes",
      }),
    ).toThrow();
    expect(() =>
      parsePublishOrganizationPolicyInput({
        organizationId: ORGANIZATION_ID,
        document: {
          ...policyDocument,
          officialAgents: { installation: "automatic" },
        },
        expectedOrganizationRevision: 2,
        expectedPolicyVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      parseOrganizationAuditPageInput({
        organizationId: ORGANIZATION_ID,
        limit: 101,
      }),
    ).toThrow();
  });

  it("serializes only renderer-safe Organization state, policy, audit, and one-time invitation fields", () => {
    const serializedState = serializeOrganizationPublicState({
      access: "online",
      cloudAvailable: true,
      stale: false,
      refreshedAt: CREATED_AT,
      organizations: [
        {
          id: ORGANIZATION_ID,
          displayName: "AgentEra",
          status: "active",
          revision: 1,
          role: "owner",
          memberCount: 1,
          departmentCount: 0,
          currentPolicyVersion: 1,
          currentPolicyDigest: DIGEST,
          mutationState: "writable",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          archivedAt: null,
          profilePath: "/private/profile",
          memoryScope: "private",
        } as never,
      ],
      accessToken: TOKEN,
    } as never);
    expect(JSON.stringify(serializedState)).not.toMatch(
      /profilePath|memoryScope|accessToken|private/,
    );

    const creation = serializeOrganizationInvitationCreation({
      invitation: {
        id: INVITATION_ID,
        status: "pending",
        createdByUserId: USER_ID,
        acceptedByUserId: null,
        createdAt: CREATED_AT,
        expiresAt: "2026-07-28T00:00:00Z",
        acceptedAt: null,
        revokedAt: null,
      },
      token: TOKEN,
      inviteUrl: `agentera://organization-invitation#${TOKEN}`,
      secretReplayable: false,
    });
    expect(creation.token).toBe(TOKEN);
    expect(creation.secretReplayable).toBe(false);

    expect(
      serializeOrganizationCurrentPolicyState({
        policy: {
          id: POLICY_ID,
          policyVersion: 1,
          schemaVersion: 1,
          contentDigest: DIGEST,
          issuer: "https://cloud.agentera.test",
          signingKeyId: "organization-key-1",
          createdAt: CREATED_AT,
          document: policyDocument,
          signature: SIGNATURE,
        },
        stale: false,
        verifiedAt: CREATED_AT,
        errorCode: null,
      }).policy,
    ).toMatchObject({ id: POLICY_ID, document: policyDocument });

    const audit = serializeOrganizationAuditPage({
      items: [
        {
          id: AUDIT_ID,
          eventType: "organization.created",
          objectType: "organization",
          objectId: ORGANIZATION_ID,
          outcome: "success",
          reasonCode: null,
          requestId: "request-1",
          actorDisplay: "Owner",
          subjectDisplay: null,
          createdAt: CREATED_AT,
          rawMetadata: { profilePath: "/private/profile" },
        } as never,
      ],
      nextCursor: TOKEN,
    });
    expect(JSON.stringify(audit)).not.toContain("rawMetadata");
  });

  it("maps failures to a bounded result without leaking messages or tokens", async () => {
    await expect(
      executeOrganizationIpc(async () => {
        throw Object.assign(new Error(`/private/profile ${TOKEN}`), {
          code: "organization_forbidden",
          responseText: "cloud body",
        });
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "organization_forbidden",
    });
    await expect(
      executeOrganizationIpc(async () => {
        throw Object.assign(new Error("offline"), {
          code: "online_required",
        });
      }),
    ).resolves.toEqual({ ok: false, errorCode: "online_required" });
    await expect(
      executeOrganizationIpc(async () => {
        throw new AgenteraOrganizationPolicyVerificationError(
          "invalid_snapshot",
        );
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "policy_verification_failed",
    });
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`/private/profile ${TOKEN}`);
        },
      },
    );
    await expect(
      executeOrganizationIpc(async () => {
        throw hostileError;
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "service_unavailable",
    });
  });
});

describe("AgentEra Organization IPC and startup wiring", () => {
  const authenticatedChannels = [
    "agentera-product-space-get-state",
    "agentera-product-space-select",
    "agentera-organization-get-state",
    "agentera-organization-list-members",
    "agentera-organization-list-departments",
    "agentera-organization-get-current-policy",
  ];
  const onlineChannels = [
    "agentera-product-space-refresh",
    "agentera-organization-refresh",
    "agentera-organization-create",
    "agentera-organization-rename",
    "agentera-organization-archive",
    "agentera-organization-restore",
    "agentera-organization-transfer-owner",
    "agentera-organization-dissolve",
    "agentera-organization-patch-member",
    "agentera-organization-remove-member",
    "agentera-organization-leave",
    "agentera-organization-create-department",
    "agentera-organization-rename-department",
    "agentera-organization-archive-department",
    "agentera-organization-restore-department",
    "agentera-organization-list-invitations",
    "agentera-organization-create-invitation",
    "agentera-organization-revoke-invitation",
    "agentera-organization-accept-invitation",
    "agentera-organization-list-policy-snapshots",
    "agentera-organization-publish-policy",
    "agentera-organization-get-policy-snapshot",
    "agentera-organization-list-audit-events",
  ];
  const preflightChannels = [
    "agentera-organization-get-pending-invitation",
    "agentera-organization-dismiss-pending-invitation",
  ];

  it("assigns every Product Space and Organization request a central access policy", () => {
    for (const channel of authenticatedChannels) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe(
        "authenticated",
      );
    }
    for (const channel of onlineChannels) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe("online");
    }
    for (const channel of preflightChannels) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe("preflight");
    }
  });

  it("registers every request through bounded Product Space or Organization executors", () => {
    const register = source("src/main/ipc/register.ts");
    for (const channel of [
      ...authenticatedChannels,
      ...onlineChannels,
      ...preflightChannels,
    ]) {
      expect(register, channel).toContain(channel);
    }
    expect(register).toContain("registerProductSpaceHandler");
    expect(register).toContain("executeProductSpaceIpc");
    expect(register).toContain("registerOrganizationHandler");
    expect(register).toContain("executeOrganizationIpc");
    expect(register).toContain("agentera-product-space-state-changed");
    expect(register).toContain("agentera-organization-state-changed");
    expect(register).toContain("agentera-organization-invitation-received");
  });

  it("constructs and closes one Organization and Product Space control plane under userData", () => {
    const start = source("src/main/app/start.ts");
    expect(start.match(/openAgenteraOrganizationDatabase\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraOrganizationClient\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraOrganizationManager\(/g)).toHaveLength(1);
    expect(start.match(/openAgenteraProductSpaceDatabase\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraProductSpaceManager\(/g)).toHaveLength(1);
    expect(start).toContain('app.getPath("userData")');
    expect(start).toContain("agenteraOrganization?.notifyAccessStateChanged()");
    expect(start).toContain("agenteraProductSpace?.notifyAccessStateChanged()");
    expect(start).toContain("agenteraProductSpace?.close()");
    expect(start).toContain("agenteraOrganization?.close()");
  });

  it("keeps Organization IPC outside all Hermes private and Runtime mutation modules", () => {
    const contract = source("src/main/agentera-organization/ipc-contract.ts");
    const registerImports = source("src/main/ipc/register.ts").slice(
      0,
      source("src/main/ipc/register.ts").indexOf("export interface IpcContext"),
    );
    expect(contract).not.toMatch(
      /from\s+["'][^"']*(?:profiles|hermes|memory|sessions|skills|curator|runtime-distribution|runtime-binding|agent-sync|gateway)/i,
    );
    expect(registerImports).not.toMatch(
      /agentera-organization[^\n]*(?:profiles|hermes|memory|sessions|skills|curator|runtime|agent-sync|gateway)/i,
    );
  });
});
