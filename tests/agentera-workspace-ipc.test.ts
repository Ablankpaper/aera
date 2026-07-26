// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../src/main/ipc/auth-guard";
import {
  createWorkspaceIdempotencyKey,
  executeWorkspaceIpc,
  parseAcceptWorkspaceInvitationInput,
  parseChangeWorkspaceMemberRoleInput,
  parseCreateWorkspaceInput,
  parseDismissWorkspaceInvitationInput,
  parseRenameWorkspaceInput,
  parseRevokeWorkspaceInvitationInput,
  parseSelectWorkspaceInput,
  parseWorkspaceIDInput,
  parseWorkspaceRevisionInput,
  serializeWorkspaceInvitation,
  serializeWorkspaceInvitationCreation,
  serializeWorkspacePublicState,
} from "../src/main/agentera-workspace/ipc-contract";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationCreation,
  WorkspacePublicState,
} from "../src/shared/agentera-workspace";

const ROOT = join(__dirname, "..");
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const INVITATION_ID = "30000000-0000-4000-8000-000000000003";
const PERSONAL_SPACE_ID = "40000000-0000-4000-8000-000000000004";
const TOKEN = "A".repeat(43);

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function invitation(): WorkspaceInvitation {
  return {
    id: INVITATION_ID,
    status: "pending",
    createdByUserId: USER_ID,
    acceptedByUserId: null,
    createdAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-27T10:00:00Z",
    acceptedAt: null,
    revokedAt: null,
  };
}

describe("Workspace IPC contract", () => {
  it("parses exact renderer inputs and rejects missing or extra fields", () => {
    expect(parseSelectWorkspaceInput({ workspaceId: null })).toEqual({
      workspaceId: null,
    });
    expect(parseSelectWorkspaceInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(parseCreateWorkspaceInput({ displayName: "Team Space" })).toEqual({
      displayName: "Team Space",
    });
    expect(
      parseRenameWorkspaceInput({
        workspaceId: WORKSPACE_ID,
        displayName: "Renamed",
        expectedRevision: 2,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      displayName: "Renamed",
      expectedRevision: 2,
    });
    expect(
      parseWorkspaceRevisionInput({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 3,
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, expectedRevision: 3 });
    expect(parseWorkspaceIDInput({ workspaceId: WORKSPACE_ID })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(
      parseChangeWorkspaceMemberRoleInput({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        role: "admin",
        expectedRevision: 1,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      role: "admin",
      expectedRevision: 1,
    });
    expect(
      parseRevokeWorkspaceInvitationInput({
        workspaceId: WORKSPACE_ID,
        invitationId: INVITATION_ID,
      }),
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      invitationId: INVITATION_ID,
    });
    expect(parseAcceptWorkspaceInvitationInput({ token: TOKEN })).toEqual({
      token: TOKEN,
    });
    expect(parseDismissWorkspaceInvitationInput({ token: TOKEN })).toEqual({
      token: TOKEN,
    });

    for (const invalid of [
      undefined,
      null,
      {},
      { workspaceId: WORKSPACE_ID, extra: true },
      { workspaceId: "not-a-uuid" },
    ]) {
      expect(() => parseWorkspaceIDInput(invalid)).toThrow();
    }
    expect(() => parseCreateWorkspaceInput({ displayName: " Team" })).toThrow();
    expect(() =>
      parseCreateWorkspaceInput({ displayName: "x".repeat(81) }),
    ).toThrow();
    expect(() =>
      parseCreateWorkspaceInput({ displayName: "bad\u0000name" }),
    ).toThrow();
    expect(() =>
      parseWorkspaceRevisionInput({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      parseChangeWorkspaceMemberRoleInput({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        role: "owner",
        expectedRevision: 1,
      }),
    ).toThrow();
    expect(() =>
      parseAcceptWorkspaceInvitationInput({ token: "B".repeat(43) }),
    ).toThrow();
    expect(() =>
      parseDismissWorkspaceInvitationInput({ token: TOKEN, extra: "secret" }),
    ).toThrow();
  });

  it("generates one validated main-process idempotency key per action", () => {
    const generated = "50000000-0000-4000-8000-000000000005";
    expect(createWorkspaceIdempotencyKey(() => generated)).toBe(generated);
    expect(() => createWorkspaceIdempotencyKey(() => "not-a-uuid")).toThrow();
  });

  it("maps failures to stable envelopes without exposing bodies, paths, or tokens", async () => {
    const mappings: Array<[string, string]> = [
      ["sign_in_required", "unauthenticated"],
      ["online_required", "online_required"],
      ["workspace_forbidden", "forbidden"],
      ["workspace_not_found", "not_found"],
      ["workspace_conflict", "conflict"],
      ["workspace_archived", "archived"],
      ["workspace_owner_unavailable", "owner_unavailable"],
      ["member_limit_reached", "limit_reached"],
      ["rate_limited", "rate_limited"],
      ["service_unavailable", "cloud_unavailable"],
      ["invalid_request", "invalid_request"],
    ];
    for (const [sourceCode, expected] of mappings) {
      const error = Object.assign(
        new Error(`/private/profile ${TOKEN} cloud-body`),
        { code: sourceCode, responseText: "private-response" },
      );
      const result = await executeWorkspaceIpc(async () => {
        throw error;
      });
      expect(result).toEqual({ ok: false, errorCode: expected });
      expect(JSON.stringify(result)).not.toMatch(/private|cloud-body|A{43}/);
    }

    const hostileError = Object.defineProperty({}, "code", {
      get() {
        throw new Error(`/private/profile ${TOKEN}`);
      },
    });
    const hostileResult = await executeWorkspaceIpc(async () => {
      throw hostileError;
    });
    expect(hostileResult).toEqual({
      ok: false,
      errorCode: "cloud_unavailable",
    });
  });

  it("serializes state and metadata through explicit public allowlists", () => {
    const state: WorkspacePublicState = {
      access: "online",
      cloudAvailable: true,
      stale: false,
      selected: {
        kind: "personal",
        userId: USER_ID,
        personalSpaceId: PERSONAL_SPACE_ID,
      },
      workspaces: [
        {
          id: WORKSPACE_ID,
          displayName: "Team",
          status: "active",
          revision: 1,
          mutationState: "writable",
          role: "owner",
          memberCount: 1,
          createdAt: "2026-07-20T10:00:00Z",
          updatedAt: "2026-07-20T10:00:00Z",
          archivedAt: null,
          profilePath: "/private/profile",
          sessionId: "private-session",
        } as never,
      ],
    };
    const serialized = serializeWorkspacePublicState({
      ...state,
      accessToken: TOKEN,
    } as never);
    expect(serialized).toEqual({
      ...state,
      workspaces: [
        {
          id: WORKSPACE_ID,
          displayName: "Team",
          status: "active",
          revision: 1,
          mutationState: "writable",
          role: "owner",
          memberCount: 1,
          createdAt: "2026-07-20T10:00:00Z",
          updatedAt: "2026-07-20T10:00:00Z",
          archivedAt: null,
        },
      ],
    });
    expect(JSON.stringify(serialized)).not.toMatch(
      /profilePath|sessionId|accessToken|private/,
    );

    const unsafeInvitation = {
      ...invitation(),
      token: TOKEN,
      inviteUrl: `agentera://workspace-invitation#${TOKEN}`,
    } as never;
    expect(serializeWorkspaceInvitation(unsafeInvitation)).toEqual(
      invitation(),
    );
    const creation: WorkspaceInvitationCreation = {
      ...invitation(),
      token: TOKEN,
      inviteUrl: `agentera://workspace-invitation#${TOKEN}`,
      secretReplayable: false,
    };
    expect(serializeWorkspaceInvitationCreation(creation)).toEqual(creation);
  });
});

describe("Workspace IPC and startup wiring", () => {
  const requestChannels = [
    "agentera-workspace-get-state",
    "agentera-workspace-refresh",
    "agentera-workspace-select",
    "agentera-workspace-create",
    "agentera-workspace-rename",
    "agentera-workspace-archive",
    "agentera-workspace-restore",
    "agentera-workspace-list-members",
    "agentera-workspace-change-member-role",
    "agentera-workspace-remove-member",
    "agentera-workspace-leave",
    "agentera-workspace-list-invitations",
    "agentera-workspace-create-invitation",
    "agentera-workspace-revoke-invitation",
    "agentera-workspace-accept-invitation",
    "agentera-workspace-get-pending-invitation",
    "agentera-workspace-dismiss-pending-invitation",
  ];

  it("assigns central product-access policy to every Workspace request", () => {
    for (const channel of requestChannels) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBeDefined();
    }
    for (const channel of [
      "agentera-workspace-get-state",
      "agentera-workspace-select",
      "agentera-workspace-list-members",
      "agentera-workspace-list-invitations",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel]).toBe("authenticated");
    }
    for (const channel of [
      "agentera-workspace-refresh",
      "agentera-workspace-create",
      "agentera-workspace-rename",
      "agentera-workspace-archive",
      "agentera-workspace-restore",
      "agentera-workspace-change-member-role",
      "agentera-workspace-remove-member",
      "agentera-workspace-leave",
      "agentera-workspace-create-invitation",
      "agentera-workspace-revoke-invitation",
      "agentera-workspace-accept-invitation",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel]).toBe("online");
    }
    expect(
      AGENTERA_IPC_CHANNEL_POLICY["agentera-workspace-get-pending-invitation"],
    ).toBe("preflight");
    expect(
      AGENTERA_IPC_CHANNEL_POLICY[
        "agentera-workspace-dismiss-pending-invitation"
      ],
    ).toBe("preflight");
  });

  it("registers every handler through the guarded safe Workspace executor", () => {
    const register = source("src/main/ipc/register.ts");
    for (const channel of requestChannels) expect(register).toContain(channel);
    expect(register).toContain("registerWorkspaceHandler");
    expect(register).toContain("executeWorkspaceIpc");
    expect(register).toContain("productAccessGuard.assert(level)");
    expect(register).toContain("window.webContents.isDestroyed()");
    expect(register).toContain("agentera-workspace-state-changed");
    expect(register).toContain("agentera-workspace-invitation-received");
  });

  it("constructs one Workspace control plane and binds it to existing auth lifecycle", () => {
    const start = source("src/main/app/start.ts");
    expect(start.match(/openAgenteraWorkspaceDatabase\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraWorkspaceClient\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraWorkspaceManager\(/g)).toHaveLength(1);
    expect(start.match(/new AgenteraAgentControlManager\(/g)).toHaveLength(1);
    expect(start).toContain("getAccessTokenForCloudRequest");
    expect(start).toContain("agenteraWorkspace?.notifyAccessStateChanged()");
    expect(start).toContain("agenteraWorkspace?.close()");
    expect(start).toContain("attachProductSpaceCoordinator");
    expect(start).not.toContain("subscribeSelectedAgentContext");
  });

  it("acquires the single-instance lock and registers protocol handling before Runtime bootstrap", () => {
    const index = source("src/main/index.ts");
    expect(index).toContain("requestSingleInstanceLock");
    expect(index).toContain("setAsDefaultProtocolClient");
    expect(index).toContain('app.on("open-url"');
    expect(index).toContain('app.on("second-instance"');
    expect(index.indexOf("requestSingleInstanceLock")).toBeLessThan(
      index.lastIndexOf("void bootstrapAndStartMainProcess()"),
    );
    expect(index).not.toMatch(
      /console\.(?:log|warn|error).*workspace-invitation/i,
    );

    const builder = source("electron-builder.yml");
    expect(builder).toContain("name: AgentEra Workspace Invitation");
    expect(builder).toMatch(/schemes:\s*\n\s*- agentera/);
  });

  it("exposes removable Workspace listeners without generic URL, token, or header APIs", () => {
    const preload = source("src/preload/index.ts");
    const declarations = source("src/preload/index.d.ts");
    expect(preload).toMatch(
      /contextBridge\.exposeInMainWorld\(\s*"agenteraWorkspace",\s*agenteraWorkspaceAPI,?\s*\)/,
    );
    expect(preload).toContain(
      'ipcRenderer.removeListener("agentera-workspace-state-changed"',
    );
    expect(preload).toMatch(
      /ipcRenderer\.removeListener\(\s*"agentera-workspace-invitation-received"/,
    );
    expect(declarations).toContain("interface AgenteraWorkspaceAPI");
    const workspaceNamespace = declarations.match(
      /interface\s+AgenteraWorkspaceAPI\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(workspaceNamespace).toBeDefined();
    expect(workspaceNamespace).not.toMatch(
      /headers|authorization|accessToken|refreshToken|databasePath|profilePath|genericUrl/i,
    );
  });

  it("keeps Workspace selection source-isolated from Hermes runtime mechanisms", () => {
    const manager = source("src/main/agentera-workspace/manager.ts");
    expect(manager).not.toMatch(
      /from\s+["'][^"']*(?:profiles|hermes|memory|skills|session|runtime-binding)/i,
    );
    expect(manager).not.toMatch(
      /switchProfile|createProfile|createRuntimeBinding|RuntimeBinding|Curator|HERMES_HOME/,
    );
  });

  it("keeps the global switcher below the brand and the account menu in the footer", () => {
    const layout = source("src/renderer/src/screens/Layout/Layout.tsx");
    const brandAt = layout.indexOf('<div className="sidebar-brand">');
    const workspaceAt = layout.indexOf("<ProductSpaceSwitcher");
    const pinnedAt = layout.indexOf(
      '<nav className="sidebar-nav sidebar-nav-pinned">',
    );
    const footerAt = layout.indexOf('<div className="sidebar-footer">');
    const accountMenuAt = layout.indexOf("<AgenteraAccountMenu");

    expect(brandAt).toBeGreaterThan(-1);
    expect(brandAt).toBeLessThan(workspaceAt);
    expect(workspaceAt).toBeLessThan(pinnedAt);
    expect(footerAt).toBeLessThan(accountMenuAt);
  });
});
