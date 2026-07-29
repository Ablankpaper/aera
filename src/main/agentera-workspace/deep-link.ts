import type { WorkspacePendingInvitation } from "../../shared/agentera-workspace";
import type { OrganizationPendingInvitation } from "../../shared/agentera-organization";
import { parseOrganizationInvitationDeepLink } from "../agentera-organization/deep-link";

const INVITATION_LINK_PATTERN =
  /^(?:aera|agentera):\/\/workspace-invitation#([A-Za-z0-9_-]{43})$/;

function isCanonicalToken(value: string): boolean {
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function parseWorkspaceInvitationDeepLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = INVITATION_LINK_PATTERN.exec(raw);
  if (!match || !isCanonicalToken(match[1])) return null;
  return match[1];
}

export function findWorkspaceInvitationInArguments(
  arguments_: readonly string[],
): string | null {
  let found: string | null = null;
  for (const argument of arguments_) {
    const token = parseWorkspaceInvitationDeepLink(argument);
    if (token !== null) found = token;
  }
  return found;
}

export type AgenteraPendingInvitation =
  | { kind: "workspace"; token: string }
  | { kind: "organization"; token: string };

export function findAgenteraInvitationInArguments(
  arguments_: readonly string[],
): AgenteraPendingInvitation | null {
  let found: AgenteraPendingInvitation | null = null;
  for (const argument of arguments_) {
    const workspaceToken = parseWorkspaceInvitationDeepLink(argument);
    if (workspaceToken !== null) {
      found = { kind: "workspace", token: workspaceToken };
      continue;
    }
    const organizationToken = parseOrganizationInvitationDeepLink(argument);
    if (organizationToken !== null) {
      found = { kind: "organization", token: organizationToken };
    }
  }
  return found;
}

export class WorkspaceInvitationInbox {
  private pending: AgenteraPendingInvitation | null = null;
  private readonly listeners = new Set<
    (invitation: WorkspacePendingInvitation) => void
  >();
  private readonly organizationListeners = new Set<
    (invitation: OrganizationPendingInvitation) => void
  >();
  private readonly allListeners = new Set<
    (invitation: AgenteraPendingInvitation) => void
  >();

  receiveDeepLink(raw: unknown): boolean {
    const workspaceToken = parseWorkspaceInvitationDeepLink(raw);
    if (workspaceToken !== null) {
      this.receive({ kind: "workspace", token: workspaceToken });
      return true;
    }
    const organizationToken = parseOrganizationInvitationDeepLink(raw);
    if (organizationToken === null) return false;
    this.receive({ kind: "organization", token: organizationToken });
    return true;
  }

  receiveArguments(arguments_: readonly string[]): boolean {
    const invitation = findAgenteraInvitationInArguments(arguments_);
    if (invitation === null) return false;
    this.receive(invitation);
    return true;
  }

  peek(): WorkspacePendingInvitation | null {
    return this.pending?.kind === "workspace"
      ? { token: this.pending.token }
      : null;
  }

  peekOrganization(): OrganizationPendingInvitation | null {
    return this.pending?.kind === "organization"
      ? { token: this.pending.token }
      : null;
  }

  peekAny(): AgenteraPendingInvitation | null {
    return this.pending === null ? null : { ...this.pending };
  }

  dismiss(token: string): boolean {
    if (this.pending?.kind !== "workspace" || token !== this.pending.token) {
      return false;
    }
    this.pending = null;
    return true;
  }

  clearAccepted(token: string): boolean {
    return this.dismiss(token);
  }

  dismissOrganization(token: string): boolean {
    if (this.pending?.kind !== "organization" || token !== this.pending.token) {
      return false;
    }
    this.pending = null;
    return true;
  }

  clearAcceptedOrganization(token: string): boolean {
    return this.dismissOrganization(token);
  }

  subscribe(
    listener: (invitation: WorkspacePendingInvitation) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeOrganization(
    listener: (invitation: OrganizationPendingInvitation) => void,
  ): () => void {
    this.organizationListeners.add(listener);
    return () => this.organizationListeners.delete(listener);
  }

  subscribeAny(
    listener: (invitation: AgenteraPendingInvitation) => void,
  ): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  private receive(invitation: AgenteraPendingInvitation): void {
    this.pending = { ...invitation };
    for (const listener of this.allListeners) {
      try {
        listener({ ...invitation });
      } catch {
        // An observer cannot change the volatile invitation handoff.
      }
    }
    const listeners =
      invitation.kind === "workspace"
        ? this.listeners
        : this.organizationListeners;
    for (const listener of listeners) {
      try {
        listener({ token: invitation.token });
      } catch {
        // An observer cannot change the volatile invitation handoff.
      }
    }
  }
}
