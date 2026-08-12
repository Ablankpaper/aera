// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import {
  CapabilityBindingStore,
  CapabilityBindingStoreError,
} from "./capability-binding-store";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const owner: AgenteraRuntimeOwner = {
  tenantId: "33333333-3333-4333-8333-333333333333",
  ownerId: "44444444-4444-4444-8444-444444444444",
  deviceInstallationId: "55555555-5555-4555-8555-555555555555",
};

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

describe("CapabilityBindingStore", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-capability-binding-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    database.sqlite
      .prepare(
        `INSERT INTO local_agent_installations (
           agent_installation_id, tenant_id, owner_id, device_installation_id,
           source_scope, source_workspace_id, update_policy,
           definition_id, selected_version_id, runtime_profile_id,
           policy_snapshot_id, status, retry_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'USER', NULL, 'manual', ?, ?, ?, ?,
                   'pending', NULL, ?, ?)`,
      )
      .run(
        INSTALLATION_ID,
        owner.tenantId,
        owner.ownerId,
        owner.deviceInstallationId,
        "66666666-6666-4666-8666-666666666666",
        "77777777-7777-4777-8777-777777777777",
        PROFILE_ID,
        "88888888-8888-4888-8888-888888888888",
        "2026-08-06T00:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
      );
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores only a local MCP name and canonical verified tool names with optimistic revision", () => {
    const store = new CapabilityBindingStore({
      database,
      owner,
      now: () => new Date("2026-08-06T00:10:00.000Z"),
    });
    const first = store.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.search", "docs.read"],
      expectedRevision: null,
    });
    expect(first).toEqual(
      expect.objectContaining({
        agentInstallationId: INSTALLATION_ID,
        requirementLogicalName: "private-docs",
        localMcpName: "employee-docs",
        verifiedTools: ["docs.read", "docs.search"],
        revision: 1,
      }),
    );
    const second = store.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs-v2",
      verifiedTools: ["docs.read"],
      expectedRevision: 1,
    });
    expect(second.revision).toBe(2);
    expect(store.list(INSTALLATION_ID, PROFILE_ID)).toEqual([second]);

    const persisted = database.sqlite
      .prepare(
        `SELECT local_mcp_name, verified_tool_names_json, revision
         FROM agent_mcp_requirement_bindings`,
      )
      .get();
    expect(persisted).toEqual({
      local_mcp_name: "employee-docs-v2",
      verified_tool_names_json: '["docs.read"]',
      revision: 2,
    });
    expect(JSON.stringify(persisted)).not.toMatch(
      /url|command|args|env|header|token|auth|credential|profilePath/i,
    );
  });

  it("rejects stale revisions and owner or Profile mismatches", () => {
    const store = new CapabilityBindingStore({ database, owner });
    const input = {
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.read"],
      expectedRevision: null,
    } as const;
    store.upsert(input);
    expect(() => store.upsert(input)).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "binding_conflict",
      }),
    );
    expect(() =>
      store.list(INSTALLATION_ID, "99999999-9999-4999-8999-999999999999"),
    ).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "installation_mismatch",
      }),
    );
    const otherOwnerStore = new CapabilityBindingStore({
      database,
      owner: {
        ...owner,
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(() =>
      otherOwnerStore.list(INSTALLATION_ID, PROFILE_ID),
    ).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "installation_mismatch",
      }),
    );
  });

  it("fails required missing, disabled, or drifted tools and degrades optional requirements", () => {
    const store = new CapabilityBindingStore({ database, owner });
    const requirements = [
      {
        logicalName: "private-docs",
        tools: ["docs.read"],
        required: true,
        permissionReason: "Read selected documents",
      },
    ];
    const resolve = (
      servers: Array<{ name: string; enabled: boolean; tools: string[] }>,
    ): ReturnType<CapabilityBindingStore["resolve"]> =>
      store.resolve({
        agentInstallationId: INSTALLATION_ID,
        runtimeProfileId: PROFILE_ID,
        requirements,
        servers,
      });

    expect(() => resolve([])).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "profile_capability_configuration_required",
      }),
    );
    store.upsert({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.read"],
      expectedRevision: null,
    });
    expect(() =>
      resolve([
        { name: "employee-docs", enabled: false, tools: ["docs.read"] },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "profile_capability_configuration_required",
      }),
    );
    expect(() =>
      resolve([
        { name: "employee-docs", enabled: true, tools: ["docs.search"] },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<CapabilityBindingStoreError>>({
        code: "profile_capability_configuration_required",
      }),
    );
    expect(
      resolve([{ name: "employee-docs", enabled: true, tools: ["docs.read"] }]),
    ).toEqual({
      bindings: [
        {
          logicalName: "private-docs",
          localMcpName: "employee-docs",
          tools: ["docs.read"],
          revision: 1,
        },
      ],
      degradedRequirements: [],
    });

    expect(
      store.resolve({
        agentInstallationId: INSTALLATION_ID,
        runtimeProfileId: PROFILE_ID,
        requirements: [{ ...requirements[0], required: false }],
        servers: [],
      }),
    ).toEqual({ bindings: [], degradedRequirements: ["private-docs"] });
  });
});
