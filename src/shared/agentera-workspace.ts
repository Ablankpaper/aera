export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspaceStatus = "active" | "archived";
export type WorkspaceMutationState =
  | "writable"
  | "archived"
  | "owner_unavailable";
export type WorkspaceInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface WorkspaceSummary {
  id: string;
  displayName: string;
  status: WorkspaceStatus;
  revision: number;
  mutationState: WorkspaceMutationState;
  role: WorkspaceRole;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface WorkspaceMember {
  userId: string;
  nickname: string | null;
  role: WorkspaceRole;
  revision: number;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  status: WorkspaceInvitationStatus;
  createdByUserId: string | null;
  acceptedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/**
 * Volatile result from the invitation-creation interaction. The secret fields
 * exist only on the first successful creation response and must never be
 * stored in WorkspacePublicState or the offline cache.
 */
export interface WorkspaceInvitationCreation extends WorkspaceInvitation {
  token?: string;
  inviteUrl?: string;
  secretReplayable: false;
}

export interface WorkspaceInvitationAcceptance {
  workspace: WorkspaceSummary;
  member: WorkspaceMember;
}

export type AgenteraSpaceContext =
  | { kind: "personal"; userId: string; personalSpaceId: string }
  | {
      kind: "workspace";
      userId: string;
      workspaceId: string;
      role: WorkspaceRole;
    };

export interface WorkspacePublicState {
  access: "online" | "offline";
  cloudAvailable: boolean;
  stale: boolean;
  selected: AgenteraSpaceContext;
  workspaces: readonly WorkspaceSummary[];
}
