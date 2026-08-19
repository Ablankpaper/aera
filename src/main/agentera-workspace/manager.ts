import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  ProductSpaceAgentContext,
  ProductSpacePublicState,
} from "../../shared/agentera-product-space";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspaceMember,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../shared/agentera-workspace";
import type { AgenteraWorkspaceDatabase } from "./db";

export type SelectedAgentContext = ProductSpaceAgentContext;

export interface AgenteraWorkspaceSelectionCoordinator {
  readSelectedWorkspaceId(accountUserId: string): string | null;
  getAgentContext(): ProductSpaceAgentContext;
  select(
    input:
      | {
          kind: "PERSONAL";
        }
      | {
          kind: "WORKSPACE";
          workspaceId: string;
        },
  ): Promise<ProductSpacePublicState>;
  subscribe(listener: (state: ProductSpacePublicState) => void): () => void;
}

export interface AgenteraWorkspaceCloudClient {
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  createWorkspace(
    displayName: string,
    idempotencyKey: string,
  ): Promise<WorkspaceSummary>;
  renameWorkspace(
    workspaceId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary>;
  archiveWorkspace(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary>;
  restoreWorkspace(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceSummary>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  changeMemberRole(
    workspaceId: string,
    userId: string,
    role: "admin" | "member",
    expectedRevision: number,
  ): Promise<WorkspaceMember>;
  removeMember(
    workspaceId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<void>;
  leaveWorkspace(workspaceId: string): Promise<void>;
  listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]>;
  createInvitation(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationCreation>;
  revokeInvitation(workspaceId: string, invitationId: string): Promise<void>;
  acceptInvitation(
    token: string,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationAcceptance>;
}

export interface CreateWorkspaceInput {
  displayName: string;
  idempotencyKey: string;
}

export interface WorkspaceIDInput {
  workspaceId: string;
}

export interface RenameWorkspaceInput extends WorkspaceIDInput {
  displayName: string;
  expectedRevision: number;
}

export interface WorkspaceRevisionInput extends WorkspaceIDInput {
  expectedRevision: number;
}

export interface ChangeWorkspaceMemberRoleInput extends WorkspaceRevisionInput {
  userId: string;
  role: "admin" | "member";
}

export interface RemoveWorkspaceMemberInput extends WorkspaceRevisionInput {
  userId: string;
}

export interface CreateWorkspaceInvitationInput extends WorkspaceIDInput {
  idempotencyKey: string;
}

export interface RevokeWorkspaceInvitationInput extends WorkspaceIDInput {
  invitationId: string;
}

export interface AcceptWorkspaceInvitationInput {
  token: string;
  idempotencyKey: string;
}

export interface AgenteraWorkspaceManagerSurface {
  getState(): Promise<WorkspacePublicState>;
  getSelectedAgentContext(): SelectedAgentContext;
  subscribeSelectedAgentContext(listener: () => void): () => void;
  refresh(): Promise<WorkspacePublicState>;
  select(input: { workspaceId: string | null }): Promise<WorkspacePublicState>;
  create(input: CreateWorkspaceInput): Promise<WorkspaceSummary>;
  rename(input: RenameWorkspaceInput): Promise<WorkspaceSummary>;
  archive(input: WorkspaceRevisionInput): Promise<WorkspaceSummary>;
  restore(input: WorkspaceRevisionInput): Promise<WorkspaceSummary>;
  listMembers(input: WorkspaceIDInput): Promise<readonly WorkspaceMember[]>;
  changeMemberRole(
    input: ChangeWorkspaceMemberRoleInput,
  ): Promise<WorkspaceMember>;
  removeMember(input: RemoveWorkspaceMemberInput): Promise<void>;
  leave(input: WorkspaceIDInput): Promise<void>;
  listInvitations(
    input: WorkspaceIDInput,
  ): Promise<readonly WorkspaceInvitation[]>;
  createInvitation(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCreation>;
  revokeInvitation(input: RevokeWorkspaceInvitationInput): Promise<void>;
  acceptInvitation(
    input: AcceptWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationAcceptance>;
  notifyAccessStateChanged(): Promise<void>;
  attachProductSpaceCoordinator(
    coordinator: AgenteraWorkspaceSelectionCoordinator,
  ): void;
  close(): void;
}

export interface AgenteraWorkspaceManagerOptions {
  database: AgenteraWorkspaceDatabase;
  client: AgenteraWorkspaceCloudClient;
  getAuthState: () => AgenteraAuthPublicState;
  selectionCoordinator?: AgenteraWorkspaceSelectionCoordinator;
  now?: () => string;
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
  promise: Promise<WorkspacePublicState>;
}

export class AgenteraWorkspaceManagerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Aera Workspace operation failed: ${code}.`);
    this.name = "AgenteraWorkspaceManagerError";
    this.code = code;
  }
}

function codedError(code: string): AgenteraWorkspaceManagerError {
  return new AgenteraWorkspaceManagerError(code);
}

function cloneWorkspace(workspace: WorkspaceSummary): WorkspaceSummary {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    status: workspace.status,
    revision: workspace.revision,
    mutationState: workspace.mutationState,
    role: workspace.role,
    memberCount: workspace.memberCount,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    archivedAt: workspace.archivedAt,
  };
}

function cloneMember(member: WorkspaceMember): WorkspaceMember {
  return {
    userId: member.userId,
    nickname: member.nickname,
    role: member.role,
    revision: member.revision,
    joinedAt: member.joinedAt,
  };
}

function cloneInvitation(invitation: WorkspaceInvitation): WorkspaceInvitation {
  return {
    id: invitation.id,
    status: invitation.status,
    createdByUserId: invitation.createdByUserId,
    acceptedByUserId: invitation.acceptedByUserId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
  };
}

function cloneInvitationCreation(
  invitation: WorkspaceInvitationCreation,
): WorkspaceInvitationCreation {
  return {
    ...cloneInvitation(invitation),
    ...(invitation.token === undefined ? {} : { token: invitation.token }),
    ...(invitation.inviteUrl === undefined
      ? {}
      : { inviteUrl: invitation.inviteUrl }),
    secretReplayable: false,
  };
}

function cloneState(state: WorkspacePublicState): WorkspacePublicState {
  return {
    access: state.access,
    cloudAvailable: state.cloudAvailable,
    stale: state.stale,
    selected:
      state.selected.kind === "personal"
        ? {
            kind: "personal",
            userId: state.selected.userId,
            personalSpaceId: state.selected.personalSpaceId,
          }
        : {
            kind: "workspace",
            userId: state.selected.userId,
            workspaceId: state.selected.workspaceId,
            role: state.selected.role,
          },
    workspaces: state.workspaces.map(cloneWorkspace),
  };
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

export class AgenteraWorkspaceManager implements AgenteraWorkspaceManagerSurface {
  private readonly database: AgenteraWorkspaceDatabase;
  private readonly client: AgenteraWorkspaceCloudClient;
  private readonly getAuthState: () => AgenteraAuthPublicState;
  private readonly now: () => string;
  private readonly listeners = new Set<(state: WorkspacePublicState) => void>();
  private readonly selectedAgentContextListeners = new Set<() => void>();
  private selectionCoordinator: AgenteraWorkspaceSelectionCoordinator | null =
    null;
  private unsubscribeSelectionCoordinator: (() => void) | null = null;
  private fingerprint: string | null = null;
  private epoch = 0;
  private currentUserIsFresh = false;
  private lastEmittedAgentContextKey: string | null = null;
  private refreshInFlight: RefreshInFlight | null = null;
  private closed = false;

  constructor(options: AgenteraWorkspaceManagerOptions) {
    this.database = options.database;
    this.client = options.client;
    this.getAuthState = options.getAuthState;
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.selectionCoordinator) {
      this.attachProductSpaceCoordinator(options.selectionCoordinator);
    }
  }

  subscribe(listener: (state: WorkspacePublicState) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<WorkspacePublicState> {
    const access = this.readAccess();
    return this.buildState(access);
  }

  getSelectedAgentContext(): SelectedAgentContext {
    if (this.selectionCoordinator) {
      return this.selectionCoordinator.getAgentContext();
    }
    const selected = this.buildState(this.readAccess()).selected;
    return selected.kind === "personal"
      ? { scope: "USER" }
      : {
          scope: "WORKSPACE",
          workspaceId: selected.workspaceId,
          role: selected.role,
        };
  }

  subscribeSelectedAgentContext(listener: () => void): () => void {
    this.assertOpen();
    this.selectedAgentContextListeners.add(listener);
    return () => this.selectedAgentContextListeners.delete(listener);
  }

  refresh(): Promise<WorkspacePublicState> {
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

  async select(input: {
    workspaceId: string | null;
  }): Promise<WorkspacePublicState> {
    const access = this.readAccess();
    const selectionEpoch = this.epoch;
    if (
      typeof input !== "object" ||
      input === null ||
      !("workspaceId" in input) ||
      (input.workspaceId !== null && typeof input.workspaceId !== "string")
    ) {
      throw codedError("invalid_request");
    }
    if (input.workspaceId !== null) {
      const selected = this.database
        .readWorkspaces(access.userId)
        .workspaces.find(({ id }) => id === input.workspaceId);
      if (!selected || selected.status !== "active") {
        throw codedError("invalid_request");
      }
    }
    if (!this.selectionCoordinator) {
      throw codedError("selection_coordinator_required");
    }
    await this.selectionCoordinator.select(
      input.workspaceId === null
        ? { kind: "PERSONAL" }
        : { kind: "WORKSPACE", workspaceId: input.workspaceId },
    );
    const current = this.readAccess();
    if (
      current.userId !== access.userId ||
      current.personalSpaceId !== access.personalSpaceId ||
      this.epoch !== selectionEpoch
    ) {
      throw codedError("unauthenticated");
    }
    return this.buildState(current);
  }

  attachProductSpaceCoordinator(
    coordinator: AgenteraWorkspaceSelectionCoordinator,
  ): void {
    this.assertOpen();
    if (this.selectionCoordinator !== null) {
      throw codedError("selection_coordinator_already_attached");
    }
    const unsubscribe = coordinator.subscribe(() => {
      try {
        this.emit(this.buildState(this.readAccess()));
      } catch {
        // No product-space state is exposed while the account is unavailable.
      }
    });
    this.selectionCoordinator = coordinator;
    this.unsubscribeSelectionCoordinator = unsubscribe;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    const snapshot = this.captureOnlineAccess();
    const workspace = await this.client.createWorkspace(
      input.displayName,
      input.idempotencyKey,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertWorkspace(access.userId, workspace);
    await this.emitCurrent(access);
    return cloneWorkspace(workspace);
  }

  async rename(input: RenameWorkspaceInput): Promise<WorkspaceSummary> {
    const snapshot = this.captureOnlineAccess();
    const workspace = await this.client.renameWorkspace(
      input.workspaceId,
      input.displayName,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertWorkspace(access.userId, workspace);
    await this.emitCurrent(access);
    return cloneWorkspace(workspace);
  }

  async archive(input: WorkspaceRevisionInput): Promise<WorkspaceSummary> {
    const snapshot = this.captureOnlineAccess();
    const workspace = await this.client.archiveWorkspace(
      input.workspaceId,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertWorkspace(access.userId, workspace);
    await this.emitCurrent(access);
    return cloneWorkspace(workspace);
  }

  async restore(input: WorkspaceRevisionInput): Promise<WorkspaceSummary> {
    const snapshot = this.captureOnlineAccess();
    const workspace = await this.client.restoreWorkspace(
      input.workspaceId,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertWorkspace(access.userId, workspace);
    await this.emitCurrent(access);
    return cloneWorkspace(workspace);
  }

  async listMembers(
    input: WorkspaceIDInput,
  ): Promise<readonly WorkspaceMember[]> {
    const access = this.readAccess();
    if (!isOnline(access)) {
      return this.database
        .readMembers(access.userId, input.workspaceId)
        .members.map(cloneMember);
    }
    const snapshot = { auth: access, epoch: this.epoch };
    const members = await this.client.listMembers(input.workspaceId);
    const current = this.requireUnchangedOnlineAccess(snapshot);
    this.database.replaceMembers(
      current.userId,
      input.workspaceId,
      members,
      this.now(),
    );
    return members.map(cloneMember);
  }

  async changeMemberRole(
    input: ChangeWorkspaceMemberRoleInput,
  ): Promise<WorkspaceMember> {
    const snapshot = this.captureOnlineAccess();
    const member = await this.client.changeMemberRole(
      input.workspaceId,
      input.userId,
      input.role,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertMember(access.userId, input.workspaceId, member);
    return cloneMember(member);
  }

  async removeMember(input: RemoveWorkspaceMemberInput): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.removeMember(
      input.workspaceId,
      input.userId,
      input.expectedRevision,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    const remaining = this.database
      .readMembers(access.userId, input.workspaceId)
      .members.filter(({ userId }) => userId !== input.userId);
    this.database.replaceMembers(
      access.userId,
      input.workspaceId,
      remaining,
      this.now(),
    );
  }

  async leave(input: WorkspaceIDInput): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.leaveWorkspace(input.workspaceId);
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.removeWorkspace(access.userId, input.workspaceId);
    await this.emitCurrent(access);
  }

  async listInvitations(
    input: WorkspaceIDInput,
  ): Promise<readonly WorkspaceInvitation[]> {
    const access = this.readAccess();
    if (!isOnline(access)) {
      return this.database
        .readInvitations(access.userId, input.workspaceId)
        .invitations.map(cloneInvitation);
    }
    const snapshot = { auth: access, epoch: this.epoch };
    const invitations = await this.client.listInvitations(input.workspaceId);
    const current = this.requireUnchangedOnlineAccess(snapshot);
    this.database.replaceInvitations(
      current.userId,
      input.workspaceId,
      invitations,
      this.now(),
    );
    return invitations.map(cloneInvitation);
  }

  async createInvitation(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCreation> {
    const snapshot = this.captureOnlineAccess();
    const invitation = await this.client.createInvitation(
      input.workspaceId,
      input.idempotencyKey,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertInvitation(
      access.userId,
      input.workspaceId,
      cloneInvitation(invitation),
    );
    return cloneInvitationCreation(invitation);
  }

  async revokeInvitation(input: RevokeWorkspaceInvitationInput): Promise<void> {
    const snapshot = this.captureOnlineAccess();
    await this.client.revokeInvitation(input.workspaceId, input.invitationId);
    const access = this.requireUnchangedOnlineAccess(snapshot);
    const remaining = this.database
      .readInvitations(access.userId, input.workspaceId)
      .invitations.filter(({ id }) => id !== input.invitationId);
    this.database.replaceInvitations(
      access.userId,
      input.workspaceId,
      remaining,
      this.now(),
    );
  }

  async acceptInvitation(
    input: AcceptWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationAcceptance> {
    const snapshot = this.captureOnlineAccess();
    const acceptance = await this.client.acceptInvitation(
      input.token,
      input.idempotencyKey,
    );
    const access = this.requireUnchangedOnlineAccess(snapshot);
    this.upsertWorkspace(access.userId, acceptance.workspace);
    this.upsertMember(
      access.userId,
      acceptance.workspace.id,
      acceptance.member,
    );
    await this.emitCurrent(access);
    return {
      workspace: cloneWorkspace(acceptance.workspace),
      member: cloneMember(acceptance.member),
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
        // Keep and emit the last safe cache if the cloud is unavailable.
      }
    }
    await this.emitCurrent(access);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.refreshInFlight = null;
    this.listeners.clear();
    this.selectedAgentContextListeners.clear();
    this.unsubscribeSelectionCoordinator?.();
    this.unsubscribeSelectionCoordinator = null;
    this.selectionCoordinator = null;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw codedError("closed");
  }

  private readAccess(): ProductAccess {
    this.assertOpen();
    const state = this.getAuthState();
    const nextFingerprint = accessFingerprint(state);
    if (nextFingerprint !== this.fingerprint) {
      this.fingerprint = nextFingerprint;
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

  private buildState(access: ProductAccess): WorkspacePublicState {
    const workspaces = this.database
      .readWorkspaces(access.userId)
      .workspaces.map(cloneWorkspace);
    const selectedWorkspaceId = this.selectionCoordinator
      ? this.selectionCoordinator.readSelectedWorkspaceId(access.userId)
      : this.database.readSelectedWorkspace(access.userId);
    const selectedWorkspace = workspaces.find(
      ({ id, status }) => id === selectedWorkspaceId && status === "active",
    );
    return {
      access: access.status === "offline" ? "offline" : "online",
      cloudAvailable: isOnline(access),
      stale: !isOnline(access) || !this.currentUserIsFresh,
      selected: selectedWorkspace
        ? {
            kind: "workspace",
            userId: access.userId,
            workspaceId: selectedWorkspace.id,
            role: selectedWorkspace.role,
          }
        : {
            kind: "personal",
            userId: access.userId,
            personalSpaceId: access.personalSpaceId,
          },
      workspaces,
    };
  }

  private async performRefresh(
    snapshot: AccessSnapshot,
  ): Promise<WorkspacePublicState> {
    const workspaces = await this.client.listWorkspaces();
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
    this.database.replaceWorkspaces(current.userId, workspaces, this.now());
    this.currentUserIsFresh = true;
    const state = this.buildState(current);
    this.emit(state);
    return state;
  }

  private clearRefresh(promise: Promise<WorkspacePublicState>): void {
    if (this.refreshInFlight?.promise === promise) {
      this.refreshInFlight = null;
    }
  }

  private upsertWorkspace(
    accountUserId: string,
    workspace: WorkspaceSummary,
  ): void {
    const cached = this.database.readWorkspaces(accountUserId).workspaces;
    this.database.replaceWorkspaces(
      accountUserId,
      [...cached.filter(({ id }) => id !== workspace.id), workspace],
      this.now(),
    );
  }

  private removeWorkspace(accountUserId: string, workspaceId: string): void {
    const cached = this.database.readWorkspaces(accountUserId).workspaces;
    this.database.replaceWorkspaces(
      accountUserId,
      cached.filter(({ id }) => id !== workspaceId),
      this.now(),
    );
  }

  private upsertMember(
    accountUserId: string,
    workspaceId: string,
    member: WorkspaceMember,
  ): void {
    const cached = this.database.readMembers(
      accountUserId,
      workspaceId,
    ).members;
    this.database.replaceMembers(
      accountUserId,
      workspaceId,
      [...cached.filter(({ userId }) => userId !== member.userId), member],
      this.now(),
    );
  }

  private upsertInvitation(
    accountUserId: string,
    workspaceId: string,
    invitation: WorkspaceInvitation,
  ): void {
    const cached = this.database.readInvitations(
      accountUserId,
      workspaceId,
    ).invitations;
    this.database.replaceInvitations(
      accountUserId,
      workspaceId,
      [...cached.filter(({ id }) => id !== invitation.id), invitation],
      this.now(),
    );
  }

  private async emitCurrent(access: ProductAccess): Promise<void> {
    this.emit(this.buildState(access));
  }

  private emit(state: WorkspacePublicState): void {
    const selectedAgentContextKey =
      state.selected.kind === "personal"
        ? "USER"
        : `WORKSPACE\0${state.selected.workspaceId}\0${state.selected.role}`;
    const selectedAgentContextChanged =
      selectedAgentContextKey !== this.lastEmittedAgentContextKey;
    this.lastEmittedAgentContextKey = selectedAgentContextKey;
    for (const listener of this.listeners) {
      try {
        listener(cloneState(state));
      } catch {
        // A renderer listener cannot change trusted Workspace state.
      }
    }
    if (!selectedAgentContextChanged) return;
    for (const listener of this.selectedAgentContextListeners) {
      try {
        listener();
      } catch {
        // A context observer cannot change trusted Workspace state.
      }
    }
  }
}
