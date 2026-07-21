// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  executeProductSpaceIpc,
  parseProductSpaceSelectionInput,
  serializeProductSpacePublicState,
} from "./ipc-contract";

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000001";

describe("AgentEra product-space IPC contract", () => {
  it("accepts only an exact selection discriminant and server-known scope ID", () => {
    expect(parseProductSpaceSelectionInput({ kind: "PERSONAL" })).toEqual({
      kind: "PERSONAL",
    });
    expect(
      parseProductSpaceSelectionInput({
        kind: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
      }),
    ).toEqual({ kind: "WORKSPACE", workspaceId: WORKSPACE_ID });
    expect(
      parseProductSpaceSelectionInput({
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
      }),
    ).toEqual({ kind: "ORGANIZATION", organizationId: ORGANIZATION_ID });
  });

  it.each([
    null,
    {},
    { kind: "DEPARTMENT", departmentId: ORGANIZATION_ID },
    { kind: "PERSONAL", role: "owner" },
    { kind: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "owner" },
    {
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      actorId: "10000000-0000-4000-8000-000000000001",
    },
    {
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      cloudOrigin: "https://attacker.invalid",
    },
    {
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      profilePath: "/tmp/profile",
    },
    { kind: "WORKSPACE", workspaceId: "not-a-uuid" },
  ])("rejects unsafe renderer selection %#", (value) => {
    expect(() => parseProductSpaceSelectionInput(value)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("serializes the exact safe public state", () => {
    expect(
      serializeProductSpacePublicState({
        access: "offline",
        stale: true,
        selected: {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          role: "auditor",
        },
        options: [
          { kind: "PERSONAL" },
          {
            kind: "WORKSPACE",
            workspaceId: WORKSPACE_ID,
            displayName: "Workspace",
            role: "member",
          },
          {
            kind: "ORGANIZATION",
            organizationId: ORGANIZATION_ID,
            displayName: "Enterprise",
            role: "auditor",
          },
        ],
      }),
    ).toEqual({
      access: "offline",
      stale: true,
      selected: {
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "auditor",
      },
      options: [
        { kind: "PERSONAL" },
        {
          kind: "WORKSPACE",
          workspaceId: WORKSPACE_ID,
          displayName: "Workspace",
          role: "member",
        },
        {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          displayName: "Enterprise",
          role: "auditor",
        },
      ],
    });
  });

  it.each([
    {
      access: "online",
      stale: false,
      selected: { kind: "PERSONAL" },
      options: [{ kind: "PERSONAL" }],
      runtimeProfileId: WORKSPACE_ID,
    },
    {
      access: "online",
      stale: false,
      selected: { kind: "PERSONAL", userId: WORKSPACE_ID },
      options: [{ kind: "PERSONAL" }],
    },
    {
      access: "online",
      stale: false,
      selected: {
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "owner",
      },
      options: [
        { kind: "PERSONAL" },
        {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          displayName: "Enterprise",
          role: "owner",
          memoryScope: "shared",
        },
      ],
    },
  ])("rejects unsafe public state %#", (value) => {
    expect(() => serializeProductSpacePublicState(value as never)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("maps failures to a bounded envelope without leaking internal state", async () => {
    await expect(
      executeProductSpaceIpc(async () => {
        throw Object.assign(new Error("/private/profile secret"), {
          code: "selection_unavailable",
          responseText: "cloud body",
        });
      }),
    ).resolves.toEqual({ ok: false, errorCode: "selection_unavailable" });
    await expect(
      executeProductSpaceIpc(async () => {
        throw Object.assign(new Error("offline"), {
          code: "online_required",
        });
      }),
    ).resolves.toEqual({ ok: false, errorCode: "online_required" });
  });
});
