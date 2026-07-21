import type { OrganizationRole } from "./agentera-organization";
import type { WorkspaceRole } from "./agentera-workspace";

export type StoredProductSpaceSelection =
  | { kind: "PERSONAL" }
  | { kind: "WORKSPACE"; workspaceId: string }
  | { kind: "ORGANIZATION"; organizationId: string };

export type ProductSpaceSelection =
  | { kind: "PERSONAL" }
  | { kind: "WORKSPACE"; workspaceId: string; role: WorkspaceRole }
  | {
      kind: "ORGANIZATION";
      organizationId: string;
      role: OrganizationRole;
    };

export type ProductSpaceOption =
  | { kind: "PERSONAL" }
  | {
      kind: "WORKSPACE";
      workspaceId: string;
      displayName: string;
      role: WorkspaceRole;
    }
  | {
      kind: "ORGANIZATION";
      organizationId: string;
      displayName: string;
      role: OrganizationRole;
    };

export interface ProductSpacePublicState {
  access: "online" | "offline";
  stale: boolean;
  selected: ProductSpaceSelection;
  options: readonly ProductSpaceOption[];
}

export type ProductSpaceAgentContext =
  | { scope: "USER" }
  | {
      scope: "WORKSPACE";
      workspaceId: string;
      role: WorkspaceRole;
    }
  | {
      scope: "ORGANIZATION";
      organizationId: string;
      role: OrganizationRole;
    };

export type ProductSpaceErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "selection_unavailable"
  | "closed"
  | "online_required"
  | "service_unavailable";

export type ProductSpaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: ProductSpaceErrorCode };
