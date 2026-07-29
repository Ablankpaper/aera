import { createHash } from "node:crypto";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  OrganizationAuditEvent,
  OrganizationCachedCollection,
  OrganizationCurrentPolicyState,
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationInvitationAcceptance,
  OrganizationInvitationCreation,
  OrganizationMember,
  OrganizationMemberPatch,
  OrganizationPage,
  OrganizationPageRequest,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationPublicState,
  OrganizationRole,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import { AgenteraOrganizationClientError } from "./client";
import type { AgenteraOrganizationDatabase } from "./db";
import {
  AgenteraOrganizationPolicyVerificationError,
  canonicalizeOrganizationPolicyDocument,
  type OrganizationPolicyVerificationInput,
  type OrganizationSigningKeySet,
  type VerifiedOrganizationPolicySnapshot,
} from "./policy-verifier";

const MAX_COLLECTED_ITEMS = 4096;
const MAX_COLLECTION_PAGES = 64;

export interface AgenteraOrganizationCloudClient {
  listOrganizations(
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationSummary>>;
  createOrganization(
    displayName: string,
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
  getOrganization(organizationId: string): Promise<OrganizationSummary>;
  renameOrganization(
    organizationId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<OrganizationSummary>;
  archiveOrganization(
    organizationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
  restoreOrganization(
    organizationId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
  transferOwner(
    organizationId: string,
    targetUserId: string,
    expectedOrganizationRevision: number,
    expectedOwnerRevision: number,
    expectedTargetRevision: number,
    confirmation: "transfer-organization-owner",
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
  dissolveOrganization(
    organizationId: string,
    displayName: string,
    expectedRevision: number,
    confirmation: "dissolve-organization",
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
  listMembers(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationMember>>;
  patchMember(
    organizationId: string,
    userId: string,
    patch: OrganizationMemberPatch,
  ): Promise<OrganizationMember>;
  removeMember(
    organizationId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<void>;
  leaveOrganization(organizationId: string): Promise<void>;
  listDepartments(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationDepartment>>;
  createDepartment(
    organizationId: string,
    displayName: string,
  ): Promise<OrganizationDepartment>;
  renameDepartment(
    organizationId: string,
    departmentId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment>;
  archiveDepartment(
    organizationId: string,
    departmentId: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment>;
  restoreDepartment(
    organizationId: string,
    departmentId: string,
    expectedRevision: number,
  ): Promise<OrganizationDepartment>;
  listInvitations(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationInvitation>>;
  createInvitation(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<OrganizationInvitationCreation>;
  revokeInvitation(organizationId: string, invitationId: string): Promise<void>;
  acceptInvitation(
    token: string,
    idempotencyKey: string,
  ): Promise<OrganizationInvitationAcceptance>;
  getCurrentPolicy(organizationId: string): Promise<OrganizationPolicySnapshot>;
  listPolicySnapshots(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationPolicySummary>>;
  publishPolicy(
    organizationId: string,
    document: OrganizationPolicyDocument,
    expectedOrganizationRevision: number,
    expectedPolicyVersion: number,
    idempotencyKey: string,
  ): Promise<OrganizationPolicySnapshot>;
  getPolicySnapshot(
    policySnapshotId: string,
  ): Promise<OrganizationPolicySnapshot>;
  listAuditEvents(
    organizationId: string,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationAuditEvent>>;
  getSigningKeys(): Promise<OrganizationSigningKeySet>;
}

export interface AgenteraOrganizationPolicyVerifierSurface {
  verify(
    input: OrganizationPolicyVerificationInput,
  ): VerifiedOrganizationPolicySnapshot;
}

export interface AgenteraOrganizationManagerOptions {
  database: AgenteraOrganizationDatabase;
  client: AgenteraOrganizationCloudClient;
  policyVerifier: AgenteraOrganizationPolicyVerifierSurface;
  getAuthState: () => AgenteraAuthPublicState;
  now?: () => string;
}

export interface OrganizationIDInput {
  organizationId: string;
}

export interface CreateOrganizationInput {
  displayName: string;
}

export interface RenameOrganizationInput extends OrganizationIDInput {
  displayName: string;
  expectedRevision: number;
}

export interface OrganizationRevisionInput extends OrganizationIDInput {
  expectedRevision: number;
}

export interface TransferOrganizationOwnerInput extends OrganizationIDInput {
  targetUserId: string;
  expectedOrganizationRevision: number;
  expectedOwnerRevision: number;
  expectedTargetRevision: number;
  confirmation: "transfer-organization-owner";
}

export interface DissolveOrganizationInput extends OrganizationIDInput {
  displayName: string;
  expectedRevision: number;
  confirmation: "dissolve-organization";
}

export interface PatchOrganizationMemberInput extends OrganizationIDInput {
  userId: string;
  patch: OrganizationMemberPatch;
}

export interface RemoveOrganizationMemberInput extends OrganizationIDInput {
  userId: string;
  expectedRevision: number;
}

export interface CreateOrganizationDepartmentInput extends OrganizationIDInput {
  displayName: string;
}

export interface RenameOrganizationDepartmentInput extends CreateOrganizationDepartmentInput {
  departmentId: string;
  expectedRevision: number;
}

export interface ReviseOrganizationDepartmentInput extends OrganizationRevisionInput {
  departmentId: string;
}

export interface RevokeOrganizationInvitationInput extends OrganizationIDInput {
  invitationId: string;
}

export interface AcceptOrganizationInvitationInput {
  token: string;
}

export interface PublishOrganizationPolicyInput extends OrganizationIDInput {
  document: OrganizationPolicyDocument;
  expectedOrganizationRevision: number;
  expectedPolicyVersion: number;
}

export interface GetOrganizationPolicySnapshotInput extends OrganizationIDInput {
  policySnapshotId: string;
}

type ProductAccess = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface AccessSnapshot {
  auth: ProductAccess;
  epoch: number;
}

interface RefreshInFlight {
  userId: string;
  epoch: number;
  promise: Promise<OrganizationPublicState>;
}

export class AgenteraOrganizationManagerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Aera Organization operation failed: ${code}.`);
    this.name = "AgenteraOrganizationManagerError";
    this.code = code;
  }
}

function codedError(code: string): AgenteraOrganizationManagerError {
  return new AgenteraOrganizationManagerError(code);
}

function accessFingerprint(state: AgenteraAuthPublicState): string {
  switch (state.status) {
    case "authenticated":
    case "offline":
      return [
        state.status,
        state.userId,
        state.personalSpaceId,
        state.cloudAvailable ? "available" : "unavailable",
      ].join("\0");
    case "unauthenticated":
      return `${state.status}\0${state.reason ?? ""}`;
    case "blocked":
      return `${state.status}\0${state.reason}`;
    case "checking":
      return state.status;
  }
}

function isOnline(access: ProductAccess): boolean {
  return access.status === "authenticated" && access.cloudAvailable;
}

function cloneOrganization(value: OrganizationSummary): OrganizationSummary {
  return {
    id: value.id,
    displayName: value.displayName,
    status: value.status,
    revision: value.revision,
    role: value.role,
    memberCount: value.memberCount,
    departmentCount: value.departmentCount,
    currentPolicyVersion: value.currentPolicyVersion,
    currentPolicyDigest: value.currentPolicyDigest,
    mutationState: value.mutationState,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
  };
}

function cloneMember(value: OrganizationMember): OrganizationMember {
  return {
    userId: value.userId,
    nickname: value.nickname,
    role: value.role,
    departmentId: value.departmentId,
    revision: value.revision,
    joinedAt: value.joinedAt,
    updatedAt: value.updatedAt,
  };
}

function cloneDepartment(
  value: OrganizationDepartment,
): OrganizationDepartment {
  return {
    id: value.id,
    displayName: value.displayName,
    status: value.status,
    memberCount: value.memberCount,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
  };
}

function cloneInvitation(
  value: OrganizationInvitation,
): OrganizationInvitation {
  return {
    id: value.id,
    status: value.status,
    createdByUserId: value.createdByUserId,
    acceptedByUserId: value.acceptedByUserId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    acceptedAt: value.acceptedAt,
    revokedAt: value.revokedAt,
  };
}

function cloneInvitationCreation(
  value: OrganizationInvitationCreation,
): OrganizationInvitationCreation {
  return {
    invitation: cloneInvitation(value.invitation),
    ...(value.token === undefined ? {} : { token: value.token }),
    ...(value.inviteUrl === undefined ? {} : { inviteUrl: value.inviteUrl }),
    secretReplayable: false,
  };
}

function clonePolicyDocument(
  value: OrganizationPolicyDocument,
): OrganizationPolicyDocument {
  return {
    schemaVersion: 1,
    models: {
      allowlist:
        value.models.allowlist === null
          ? null
          : value.models.allowlist.map(({ provider, model }) => ({
              provider,
              model,
            })),
    },
    tools: {
      allowlist:
        value.tools.allowlist === null ? null : [...value.tools.allowlist],
    },
    experienceCandidates: { mode: value.experienceCandidates.mode },
    officialAgents: { installation: value.officialAgents.installation },
  };
}

function clonePolicySnapshot(
  value: OrganizationPolicySnapshot,
): OrganizationPolicySnapshot {
  return {
    id: value.id,
    policyVersion: value.policyVersion,
    schemaVersion: 1,
    contentDigest: value.contentDigest,
    issuer: value.issuer,
    signingKeyId: value.signingKeyId,
    createdAt: value.createdAt,
    document:
      value.document === null ? null : clonePolicyDocument(value.document),
    signature: value.signature,
  };
}

function clonePolicySummary(
  value: OrganizationPolicySummary,
): OrganizationPolicySummary {
  return {
    id: value.id,
    policyVersion: value.policyVersion,
    schemaVersion: 1,
    contentDigest: value.contentDigest,
    issuer: value.issuer,
    signingKeyId: value.signingKeyId,
    createdAt: value.createdAt,
  };
}

function cloneAuditEvent(
  value: OrganizationAuditEvent,
): OrganizationAuditEvent {
  return {
    id: value.id,
    eventType: value.eventType,
    objectType: value.objectType,
    objectId: value.objectId,
    outcome: value.outcome,
    reasonCode: value.reasonCode,
    requestId: value.requestId,
    actorDisplay: value.actorDisplay,
    subjectDisplay: value.subjectDisplay,
    createdAt: value.createdAt,
  };
}

function canonicalRequestDigest(operation: string, body: unknown): string {
  return createHash("sha256")
    .update("agentera-organization-desktop-intent-v1\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
}

function definitiveClientFailure(error: unknown): boolean {
  return (
    error instanceof AgenteraOrganizationClientError &&
    error.status >= 400 &&
    error.status < 500
  );
}

export class AgenteraOrganizationManager {
  private readonly database: AgenteraOrganizationDatabase;
  private readonly client: AgenteraOrganizationCloudClient;
  private readonly policyVerifier: AgenteraOrganizationPolicyVerifierSurface;
  private readonly getAuthState: () => AgenteraAuthPublicState;
  private readonly now: () => string;
  private readonly listeners = new Set<
    (state: OrganizationPublicState) => void
  >();
  private fingerprint: string | null = null;
  private epoch = 0;
  private currentUserIsFresh = false;
  private refreshInFlight: RefreshInFlight | null = null;
  private closed = false;

  constructor(options: AgenteraOrganizationManagerOptions) {
    this.database = options.database;
    this.client = options.client;
    this.policyVerifier = options.policyVerifier;
    this.getAuthState = options.getAuthState;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: (state: OrganizationPublicState) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<OrganizationPublicState> {
    return this.buildState(this.readAccess());
  }

  refresh(): Promise<OrganizationPublicState> {
    let snapshot: AccessSnapshot;
    try {
      snapshot = this.captureOnlineAccess();
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      this.refreshInFlight?.userId === snapshot.auth.userId &&
      this.refreshInFlight.epoch === snapshot.epoch
    ) {
      return this.refreshInFlight.promise;
    }
    const promise = this.performRefresh(snapshot);
    this.refreshInFlight = {
      userId: snapshot.auth.userId,
      epoch: snapshot.epoch,
      promise,
    };
    void promise.then(
      () => this.clearRefresh(promise),
      () => this.clearRefresh(promise),
    );
    return promise;
  }

  async create(input: CreateOrganizationInput): Promise<OrganizationSummary> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      "organization.create",
      snapshot.auth.userId,
      { displayName: input.displayName },
      (key) => this.client.createOrganization(input.displayName, key),
      (organization, access) => {
        this.upsertOrganization(access.userId, organization);
        this.emitCurrent(access);
      },
    );
    return cloneOrganization(result);
  }

  async rename(input: RenameOrganizationInput): Promise<OrganizationSummary> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.client.renameOrganization(
      input.organizationId,
      input.displayName,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertOrganization(access.userId, result);
    this.emitCurrent(access);
    return cloneOrganization(result);
  }

  archive(input: OrganizationRevisionInput): Promise<OrganizationSummary> {
    return this.reviseOrganization(input, "archive");
  }

  restore(input: OrganizationRevisionInput): Promise<OrganizationSummary> {
    return this.reviseOrganization(input, "restore");
  }

  async transferOwner(
    input: TransferOrganizationOwnerInput,
  ): Promise<OrganizationSummary> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      "organization.owner.transfer",
      input.organizationId,
      input,
      (key) =>
        this.client.transferOwner(
          input.organizationId,
          input.targetUserId,
          input.expectedOrganizationRevision,
          input.expectedOwnerRevision,
          input.expectedTargetRevision,
          input.confirmation,
          key,
        ),
      (organization, access) => {
        this.upsertOrganization(access.userId, organization);
        this.emitCurrent(access);
      },
    );
    return cloneOrganization(result);
  }

  async dissolve(
    input: DissolveOrganizationInput,
  ): Promise<OrganizationSummary> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      "organization.dissolve",
      input.organizationId,
      input,
      (key) =>
        this.client.dissolveOrganization(
          input.organizationId,
          input.displayName,
          input.expectedRevision,
          input.confirmation,
          key,
        ),
      (_organization, access) => {
        this.removeOrganization(access.userId, input.organizationId);
        this.emitCurrent(access);
      },
    );
    return cloneOrganization(result);
  }

  async listMembers(
    input: OrganizationIDInput,
  ): Promise<OrganizationCachedCollection<OrganizationMember>> {
    const access = this.readAccess();
    if (!isOnline(access)) {
      const cached = this.database.readMembers(
        access.userId,
        input.organizationId,
      );
      return {
        items: cached.members.map(cloneMember),
        stale: true,
        refreshedAt: cached.refreshedAt,
      };
    }
    const snapshot = { auth: access, epoch: this.epoch };
    const members = await this.collectAll((page) =>
      this.client.listMembers(input.organizationId, page),
    );
    const current = this.requireUnchangedOnlineAccess(snapshot);
    const refreshedAt = this.now();
    this.database.replaceMembers(
      current.userId,
      input.organizationId,
      members,
      refreshedAt,
    );
    return { items: members.map(cloneMember), stale: false, refreshedAt };
  }

  async patchMember(
    input: PatchOrganizationMemberInput,
  ): Promise<OrganizationMember> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.client.patchMember(
      input.organizationId,
      input.userId,
      input.patch,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertMember(access.userId, input.organizationId, result);
    return cloneMember(result);
  }

  async removeMember(input: RemoveOrganizationMemberInput): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.removeMember(
      input.organizationId,
      input.userId,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    const remaining = this.database
      .readMembers(access.userId, input.organizationId)
      .members.filter(({ userId }) => userId !== input.userId);
    this.database.replaceMembers(
      access.userId,
      input.organizationId,
      remaining,
      this.now(),
    );
  }

  async leave(input: OrganizationIDInput): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.leaveOrganization(input.organizationId);
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.removeOrganization(access.userId, input.organizationId);
    this.emitCurrent(access);
  }

  async listDepartments(
    input: OrganizationIDInput,
  ): Promise<OrganizationCachedCollection<OrganizationDepartment>> {
    const access = this.readAccess();
    if (!isOnline(access)) {
      const cached = this.database.readDepartments(
        access.userId,
        input.organizationId,
      );
      return {
        items: cached.departments.map(cloneDepartment),
        stale: true,
        refreshedAt: cached.refreshedAt,
      };
    }
    const snapshot = { auth: access, epoch: this.epoch };
    const departments = await this.collectAll((page) =>
      this.client.listDepartments(input.organizationId, page),
    );
    const current = this.requireUnchangedOnlineAccess(snapshot);
    const refreshedAt = this.now();
    this.database.replaceDepartments(
      current.userId,
      input.organizationId,
      departments,
      refreshedAt,
    );
    return {
      items: departments.map(cloneDepartment),
      stale: false,
      refreshedAt,
    };
  }

  async createDepartment(
    input: CreateOrganizationDepartmentInput,
  ): Promise<OrganizationDepartment> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.client.createDepartment(
      input.organizationId,
      input.displayName,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertDepartment(access.userId, input.organizationId, result);
    return cloneDepartment(result);
  }

  async renameDepartment(
    input: RenameOrganizationDepartmentInput,
  ): Promise<OrganizationDepartment> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.client.renameDepartment(
      input.organizationId,
      input.departmentId,
      input.displayName,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertDepartment(access.userId, input.organizationId, result);
    return cloneDepartment(result);
  }

  archiveDepartment(
    input: ReviseOrganizationDepartmentInput,
  ): Promise<OrganizationDepartment> {
    return this.reviseDepartment(input, "archive");
  }

  restoreDepartment(
    input: ReviseOrganizationDepartmentInput,
  ): Promise<OrganizationDepartment> {
    return this.reviseDepartment(input, "restore");
  }

  async listInvitations(
    input: OrganizationIDInput,
  ): Promise<OrganizationCachedCollection<OrganizationInvitation>> {
    const snapshot = this.captureOnlineAccess();
    this.requireCachedRole(snapshot.auth.userId, input.organizationId, [
      "owner",
      "admin",
    ]);
    const invitations = await this.collectAll((page) =>
      this.client.listInvitations(input.organizationId, page),
    );
    const current = this.requireUnchangedOnlineAccess(snapshot);
    const refreshedAt = this.now();
    this.database.replaceInvitations(
      current.userId,
      input.organizationId,
      invitations,
      refreshedAt,
    );
    return {
      items: invitations.map(cloneInvitation),
      stale: false,
      refreshedAt,
    };
  }

  async createInvitation(
    input: OrganizationIDInput,
  ): Promise<OrganizationInvitationCreation> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      "organization.invitation.create",
      input.organizationId,
      { organizationId: input.organizationId },
      (key) => this.client.createInvitation(input.organizationId, key),
      (created, access) => {
        this.upsertInvitation(
          access.userId,
          input.organizationId,
          created.invitation,
        );
      },
    );
    return cloneInvitationCreation(result);
  }

  async revokeInvitation(
    input: RevokeOrganizationInvitationInput,
  ): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.revokeInvitation(
      input.organizationId,
      input.invitationId,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    const remaining = this.database
      .readInvitations(access.userId, input.organizationId)
      .invitations.filter(({ id }) => id !== input.invitationId);
    this.database.replaceInvitations(
      access.userId,
      input.organizationId,
      remaining,
      this.now(),
    );
  }

  async acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<OrganizationInvitationAcceptance> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      "organization.invitation.accept",
      snapshot.auth.userId,
      { token: input.token },
      (key) => this.client.acceptInvitation(input.token, key),
      (accepted, access) => {
        this.upsertOrganization(access.userId, accepted.organization);
        this.upsertMember(
          access.userId,
          accepted.organization.id,
          accepted.member,
        );
        this.emitCurrent(access);
      },
    );
    return {
      organization: cloneOrganization(result.organization),
      member: cloneMember(result.member),
    };
  }

  async getCurrentPolicy(
    input: OrganizationIDInput,
  ): Promise<OrganizationCurrentPolicyState> {
    const access = this.readAccess();
    if (!isOnline(access)) {
      return this.cachedPolicyState(access, input.organizationId, null);
    }
    const snapshot = { auth: access, epoch: this.epoch };
    const remote = await this.client.getCurrentPolicy(input.organizationId);
    const cachedRole = this.database
      .readOrganizations(access.userId)
      .organizations.find(({ id }) => id === input.organizationId)?.role;
    if (cachedRole === "member") {
      this.requireUnchangedOnlineAccess(snapshot);
      const policy = clonePolicySnapshot(remote);
      policy.document = null;
      policy.signature = null;
      return {
        policy,
        stale: false,
        verifiedAt: null,
        errorCode: null,
      };
    }
    if (remote.document === null || remote.signature === null) {
      this.requireUnchangedOnlineAccess(snapshot);
      return {
        policy: clonePolicySnapshot(remote),
        stale: false,
        verifiedAt: null,
        errorCode: null,
      };
    }
    const keys = await this.client.getSigningKeys();
    const current = this.requireUnchangedOnlineAccess(snapshot);
    try {
      const verified = this.policyVerifier.verify({
        organizationId: input.organizationId,
        snapshot: remote,
        keySet: keys,
      });
      const verifiedAt = this.now();
      this.database.writeVerifiedPolicy(current.userId, verified, verifiedAt);
      return {
        policy: clonePolicySnapshot(verified.snapshot),
        stale: false,
        verifiedAt,
        errorCode: null,
      };
    } catch (error) {
      if (
        !(error instanceof AgenteraOrganizationPolicyVerificationError) &&
        !(
          error instanceof Error &&
          /verified policy|policy is stale/i.test(error.message)
        )
      ) {
        throw error;
      }
      return this.cachedPolicyState(
        current,
        input.organizationId,
        "policy_verification_failed",
      );
    }
  }

  async listPolicySnapshots(
    input: OrganizationIDInput,
  ): Promise<readonly OrganizationPolicySummary[]> {
    const snapshot = this.captureOnlineAccess();
    this.requireCachedRole(snapshot.auth.userId, input.organizationId, [
      "owner",
      "admin",
      "auditor",
    ]);
    const policies = await this.collectAll((page) =>
      this.client.listPolicySnapshots(input.organizationId, page),
    );
    this.requireUnchangedOnlineAccess(snapshot);
    return policies.map(clonePolicySummary);
  }

  async publishPolicy(
    input: PublishOrganizationPolicyInput,
  ): Promise<OrganizationPolicySnapshot> {
    const snapshot = this.captureOnlineAccess();
    const canonical = canonicalizeOrganizationPolicyDocument(input.document);
    const result = await this.runIdempotent(
      snapshot,
      "organization.policy.publish",
      input.organizationId,
      {
        organizationId: input.organizationId,
        document: canonical.document,
        expectedOrganizationRevision: input.expectedOrganizationRevision,
        expectedPolicyVersion: input.expectedPolicyVersion,
      },
      async (key) => {
        const policy = await this.client.publishPolicy(
          input.organizationId,
          canonical.document,
          input.expectedOrganizationRevision,
          input.expectedPolicyVersion,
          key,
        );
        const keySet = await this.client.getSigningKeys();
        return this.policyVerifier.verify({
          organizationId: input.organizationId,
          snapshot: policy,
          keySet,
        });
      },
      (verified, access) => {
        this.database.writeVerifiedPolicy(access.userId, verified, this.now());
      },
    );
    return clonePolicySnapshot(result.snapshot);
  }

  async getPolicySnapshot(
    input: GetOrganizationPolicySnapshotInput,
  ): Promise<OrganizationPolicySnapshot> {
    const snapshot = this.captureOnlineAccess();
    this.requireCachedRole(snapshot.auth.userId, input.organizationId, [
      "owner",
      "admin",
      "auditor",
    ]);
    const policy = await this.client.getPolicySnapshot(input.policySnapshotId);
    const keySet = await this.client.getSigningKeys();
    this.requireUnchangedOnlineAccess(snapshot);
    const verified = this.policyVerifier.verify({
      organizationId: input.organizationId,
      snapshot: policy,
      keySet,
    });
    return clonePolicySnapshot(verified.snapshot);
  }

  async listAuditEvents(
    input: OrganizationIDInput,
    page?: OrganizationPageRequest,
  ): Promise<OrganizationPage<OrganizationAuditEvent>> {
    const snapshot = this.captureOnlineAccess();
    this.requireCachedRole(snapshot.auth.userId, input.organizationId, [
      "owner",
      "admin",
      "auditor",
    ]);
    const result = await this.client.listAuditEvents(
      input.organizationId,
      page,
    );
    this.requireUnchangedOnlineAccess(snapshot);
    return {
      items: result.items.map(cloneAuditEvent),
      nextCursor: result.nextCursor,
    };
  }

  async notifyAccessStateChanged(): Promise<void> {
    let access: ProductAccess;
    try {
      access = this.readAccess();
    } catch {
      return;
    }
    if (isOnline(access)) {
      try {
        await this.refresh();
        return;
      } catch {
        // Keep and emit only the last safe account-partitioned cache.
      }
    }
    this.emitCurrent(access);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.refreshInFlight = null;
    this.listeners.clear();
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw codedError("closed");
  }

  private readAccess(): ProductAccess {
    this.assertOpen();
    const state = this.getAuthState();
    const fingerprint = accessFingerprint(state);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.epoch += 1;
      this.currentUserIsFresh = false;
    }
    if (state.status !== "authenticated" && state.status !== "offline") {
      throw codedError("unauthenticated");
    }
    return state;
  }

  private captureOnlineAccess(): AccessSnapshot {
    const auth = this.readAccess();
    if (!isOnline(auth)) throw codedError("online_required");
    return { auth, epoch: this.epoch };
  }

  private requireUnchangedOnlineAccess(
    snapshot: AccessSnapshot,
  ): ProductAccess {
    let current: ProductAccess;
    try {
      current = this.readAccess();
    } catch {
      throw codedError("unauthenticated");
    }
    if (
      current.userId !== snapshot.auth.userId ||
      current.personalSpaceId !== snapshot.auth.personalSpaceId ||
      this.epoch !== snapshot.epoch
    ) {
      throw codedError("unauthenticated");
    }
    if (!isOnline(current)) throw codedError("online_required");
    return current;
  }

  private buildState(access: ProductAccess): OrganizationPublicState {
    const cached = this.database.readOrganizations(access.userId);
    return {
      access: access.status === "offline" ? "offline" : "online",
      cloudAvailable: isOnline(access),
      stale: !isOnline(access) || !this.currentUserIsFresh,
      refreshedAt: cached.refreshedAt,
      organizations: cached.organizations.map(cloneOrganization),
    };
  }

  private async performRefresh(
    snapshot: AccessSnapshot,
  ): Promise<OrganizationPublicState> {
    const organizations = await this.collectAll((page) =>
      this.client.listOrganizations(page),
    );
    let current: ProductAccess;
    try {
      current = this.readAccess();
    } catch {
      throw codedError("unauthenticated");
    }
    if (
      current.userId !== snapshot.auth.userId ||
      current.personalSpaceId !== snapshot.auth.personalSpaceId ||
      this.epoch !== snapshot.epoch ||
      !isOnline(current)
    ) {
      return this.buildState(current);
    }
    this.database.replaceOrganizations(
      current.userId,
      organizations,
      this.now(),
    );
    this.currentUserIsFresh = true;
    const state = this.buildState(current);
    this.emit(state);
    return state;
  }

  private clearRefresh(promise: Promise<OrganizationPublicState>): void {
    if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null;
  }

  private async collectAll<T>(
    fetchPage: (page?: OrganizationPageRequest) => Promise<OrganizationPage<T>>,
  ): Promise<T[]> {
    const items: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let index = 0; index < MAX_COLLECTION_PAGES; index += 1) {
      const result = await fetchPage(
        cursor === null ? { limit: 100 } : { limit: 100, cursor },
      );
      items.push(...result.items);
      if (items.length > MAX_COLLECTED_ITEMS)
        throw codedError("invalid_response");
      if (result.nextCursor === null) return items;
      if (cursors.has(result.nextCursor)) throw codedError("invalid_response");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw codedError("invalid_response");
  }

  private requireCachedRole(
    accountUserId: string,
    organizationId: string,
    allowed: readonly OrganizationRole[],
  ): OrganizationSummary {
    const organization = this.database
      .readOrganizations(accountUserId)
      .organizations.find(({ id }) => id === organizationId);
    if (!organization) throw codedError("not_found");
    if (!allowed.includes(organization.role)) throw codedError("forbidden");
    return organization;
  }

  private cachedPolicyState(
    access: ProductAccess,
    organizationId: string,
    errorCode: "policy_verification_failed" | null,
  ): OrganizationCurrentPolicyState {
    const cached = this.database.readCurrentPolicy(
      access.userId,
      organizationId,
    );
    if (cached.policy === null) {
      return { policy: null, stale: true, verifiedAt: null, errorCode };
    }
    const role = this.database
      .readOrganizations(access.userId)
      .organizations.find(({ id }) => id === organizationId)?.role;
    const policy = clonePolicySnapshot(cached.policy.snapshot);
    if (role === "member") {
      policy.document = null;
      policy.signature = null;
    }
    return {
      policy,
      stale: true,
      verifiedAt: cached.verifiedAt,
      errorCode,
    };
  }

  private async runIdempotent<T>(
    snapshot: AccessSnapshot,
    operation: string,
    resourceId: string,
    request: unknown,
    action: (idempotencyKey: string) => Promise<T>,
    apply: (result: T, access: ProductAccess) => void | Promise<void>,
  ): Promise<T> {
    const requestDigest = canonicalRequestDigest(operation, request);
    let intent;
    try {
      intent = this.database.acquireMutationIntent(snapshot.auth.userId, {
        operation,
        resourceId,
        requestDigest,
        createdAt: this.now(),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /conflicting mutation intent/i.test(error.message)
      ) {
        throw codedError("mutation_pending");
      }
      throw error;
    }
    let result: T;
    try {
      result = await action(intent.idempotencyKey);
    } catch (error) {
      const access = this.requireUnchangedOnlineAccess(snapshot);
      if (definitiveClientFailure(error)) {
        this.database.completeMutationIntent(
          access.userId,
          intent.idempotencyKey,
        );
      }
      throw error;
    }
    const access = this.requireUnchangedOnlineAccess(snapshot);
    await apply(result, access);
    this.database.completeMutationIntent(access.userId, intent.idempotencyKey);
    return result;
  }

  private async reviseOrganization(
    input: OrganizationRevisionInput,
    action: "archive" | "restore",
  ): Promise<OrganizationSummary> {
    const snapshot = this.captureOnlineAccess();
    const result = await this.runIdempotent(
      snapshot,
      `organization.${action}`,
      input.organizationId,
      input,
      (key) =>
        action === "archive"
          ? this.client.archiveOrganization(
              input.organizationId,
              input.expectedRevision,
              key,
            )
          : this.client.restoreOrganization(
              input.organizationId,
              input.expectedRevision,
              key,
            ),
      (organization, access) => {
        this.upsertOrganization(access.userId, organization);
        this.emitCurrent(access);
      },
    );
    return cloneOrganization(result);
  }

  private async reviseDepartment(
    input: ReviseOrganizationDepartmentInput,
    action: "archive" | "restore",
  ): Promise<OrganizationDepartment> {
    const snapshot = this.captureOnlineAccess();
    const result =
      action === "archive"
        ? await this.client.archiveDepartment(
            input.organizationId,
            input.departmentId,
            input.expectedRevision,
          )
        : await this.client.restoreDepartment(
            input.organizationId,
            input.departmentId,
            input.expectedRevision,
          );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertDepartment(access.userId, input.organizationId, result);
    return cloneDepartment(result);
  }

  private upsertOrganization(
    accountUserId: string,
    organization: OrganizationSummary,
  ): void {
    const cached = this.database.readOrganizations(accountUserId).organizations;
    this.database.replaceOrganizations(
      accountUserId,
      [...cached.filter(({ id }) => id !== organization.id), organization],
      this.now(),
    );
  }

  private removeOrganization(
    accountUserId: string,
    organizationId: string,
  ): void {
    const cached = this.database.readOrganizations(accountUserId).organizations;
    this.database.replaceOrganizations(
      accountUserId,
      cached.filter(({ id }) => id !== organizationId),
      this.now(),
    );
  }

  private upsertMember(
    accountUserId: string,
    organizationId: string,
    member: OrganizationMember,
  ): void {
    const cached = this.database.readMembers(
      accountUserId,
      organizationId,
    ).members;
    this.database.replaceMembers(
      accountUserId,
      organizationId,
      [...cached.filter(({ userId }) => userId !== member.userId), member],
      this.now(),
    );
  }

  private upsertDepartment(
    accountUserId: string,
    organizationId: string,
    department: OrganizationDepartment,
  ): void {
    const cached = this.database.readDepartments(
      accountUserId,
      organizationId,
    ).departments;
    this.database.replaceDepartments(
      accountUserId,
      organizationId,
      [...cached.filter(({ id }) => id !== department.id), department],
      this.now(),
    );
  }

  private upsertInvitation(
    accountUserId: string,
    organizationId: string,
    invitation: OrganizationInvitation,
  ): void {
    const cached = this.database.readInvitations(
      accountUserId,
      organizationId,
    ).invitations;
    this.database.replaceInvitations(
      accountUserId,
      organizationId,
      [...cached.filter(({ id }) => id !== invitation.id), invitation],
      this.now(),
    );
  }

  private emitCurrent(access: ProductAccess): void {
    this.emit(this.buildState(access));
  }

  private emit(state: OrganizationPublicState): void {
    for (const listener of this.listeners) {
      try {
        listener({
          ...state,
          organizations: state.organizations.map(cloneOrganization),
        });
      } catch {
        // An observer cannot affect the trusted Organization state.
      }
    }
  }
}
