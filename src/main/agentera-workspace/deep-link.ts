import type { WorkspacePendingInvitation } from "../../shared/agentera-workspace";

const INVITATION_LINK_PATTERN =
  /^agentera:\/\/workspace-invitation#([A-Za-z0-9_-]{43})$/;

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

export class WorkspaceInvitationInbox {
  private token: string | null = null;
  private readonly listeners = new Set<
    (invitation: WorkspacePendingInvitation) => void
  >();

  receiveDeepLink(raw: unknown): boolean {
    const token = parseWorkspaceInvitationDeepLink(raw);
    if (token === null) return false;
    this.receiveToken(token);
    return true;
  }

  receiveArguments(arguments_: readonly string[]): boolean {
    const token = findWorkspaceInvitationInArguments(arguments_);
    if (token === null) return false;
    this.receiveToken(token);
    return true;
  }

  peek(): WorkspacePendingInvitation | null {
    return this.token === null ? null : { token: this.token };
  }

  dismiss(token: string): boolean {
    if (token !== this.token) return false;
    this.token = null;
    return true;
  }

  clearAccepted(token: string): boolean {
    return this.dismiss(token);
  }

  subscribe(
    listener: (invitation: WorkspacePendingInvitation) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receiveToken(token: string): void {
    this.token = token;
    for (const listener of this.listeners) {
      try {
        listener({ token });
      } catch {
        // An observer cannot change the volatile invitation handoff.
      }
    }
  }
}
