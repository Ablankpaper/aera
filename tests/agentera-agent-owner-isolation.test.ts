// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgenteraAgentControlClient } from "../src/main/agentera-agent-control/client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "../src/main/agentera-agent-control/db";
import { AgenteraAgentControlManager } from "../src/main/agentera-agent-control/manager";
import type { AgenteraRuntimeOwner } from "../src/main/agentera-profile-binding";

const OWNER_A: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const OWNER_B: AgenteraRuntimeOwner = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  ownerId: "55555555-5555-4555-8555-555555555555",
  deviceInstallationId: "66666666-6666-4666-8666-666666666666",
};

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

describe("Agent control local USER ownership", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[agentera-agent-control-plane#Local account isolation]]
  it("switches one long-lived manager without exposing the previous account", () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-owner-isolation-"));
    roots.push(root);
    const database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    let owner = OWNER_A;
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
      } as AgenteraAgentControlClient,
      profileBindings: {} as never,
      profiles: {} as never,
      userDataPath: join(root, "user-data"),
      getOwner: () => owner,
      getAuthState: () => ({
        status: "authenticated",
        userId: owner.ownerId,
        personalSpaceId: owner.tenantId,
        deviceId: owner.deviceInstallationId,
        offlineExpiresAt: "2026-07-26T00:00:00.000Z",
        cloudAvailable: false,
      }),
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });

    const created = manager.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Account A draft",
      icon: null,
      manifest: {
        schemaVersion: 1,
        identity: { systemPrompt: "Stay in the owning personal space." },
        assets: [],
        modelConstraints: {
          allowedProviders: ["openai"],
          allowedModels: ["gpt-5.6"],
        },
        tools: { allowed: [], denied: [] },
        dependencies: [],
        runtimeCompatibility: {
          minimumVersion: "v0.18.2-agentera.1",
          maximumVersionExclusive: null,
        },
      },
      assets: [],
    });
    expect(manager.getState().draftCount).toBe(1);

    owner = OWNER_B;
    expect(manager.getState().draftCount).toBe(0);
    expect(manager.listDrafts()).toEqual([]);
    expect(() => manager.getDraft(created.id)).toThrow(
      expect.objectContaining({ code: "draft_not_found" }),
    );

    owner = OWNER_A;
    expect(manager.listDrafts().map(({ id }) => id)).toEqual([created.id]);
    database.close();
  });
});
