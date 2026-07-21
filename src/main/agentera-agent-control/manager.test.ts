// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAgentControlClient } from "./client";
import type { AgenteraHermesAdapter } from "./hermes-adapter";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgenteraAgentControlManager } from "./manager";

const OWNER = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  deviceInstallationId: "10000000-0000-4000-8000-000000000003",
};
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";

describe("Agent control Organization Foundation context", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows no personal or Workspace assets and blocks every Agent control operation before local or runtime stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-organization-agent-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");
    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: (path) =>
        new DatabaseSync(path) as unknown as AgenteraSqliteDatabase,
    });
    const clientCall = vi.fn();
    const profileCall = vi.fn();
    const bindingCall = vi.fn();
    const runtimeVersion = vi.fn(() => "v0.18.2-agentera.1");
    const manager = new AgenteraAgentControlManager({
      database,
      client: new Proxy(
        { origin: "https://cloud.agentera.test" },
        {
          get(target, property, receiver) {
            if (Reflect.has(target, property)) {
              return Reflect.get(target, property, receiver);
            }
            return clientCall;
          },
        },
      ) as unknown as AgenteraAgentControlClient,
      profileBindings: {
        verifyProfileBinding: bindingCall,
        bindFreshProfile: bindingCall,
        claimProfile: bindingCall,
      } as never,
      profiles: {
        createProfile: profileCall,
        resolveProfilePath: profileCall,
        activateProfile: profileCall,
      },
      userDataPath,
      getOwner: () => OWNER,
      getAgentContext: () =>
        ({
          scope: "ORGANIZATION_UNAVAILABLE",
          organizationId: ORGANIZATION_ID,
          role: "auditor",
        }) as never,
      getAuthState: () => ({
        status: "authenticated",
        userId: OWNER.ownerId,
        personalSpaceId: OWNER.tenantId,
        deviceId: OWNER.deviceInstallationId,
        offlineExpiresAt: "2026-07-28T00:00:00.000Z",
        cloudAvailable: true,
      }),
      getRuntimeVersion: runtimeVersion,
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });
    const prepare = vi.spyOn(database.sqlite, "prepare");

    expect(manager.getState()).toEqual({
      access: "online",
      cloudAvailable: true,
      context: {
        scope: "ORGANIZATION_UNAVAILABLE",
        organizationId: ORGANIZATION_ID,
        role: "auditor",
      },
      draftCount: 0,
      installationCount: 0,
    });
    expect(prepare).not.toHaveBeenCalled();

    const operations: Array<() => unknown> = [
      () => manager.listDrafts(),
      () => manager.getDraft("draft"),
      () => manager.createDraft({} as never),
      () => manager.updateDraft({} as never),
      () => manager.deleteDraft("draft"),
      () => manager.preparePublication("draft"),
      () => manager.confirmPublication("handle"),
      () => manager.listDefinitions(),
      () => manager.listVersions("definition"),
      () => manager.listInstallations(),
      () => manager.installVersion({} as never),
      () => manager.claimVersion({} as never),
      () => manager.retryPendingInstallation({} as never),
      () => manager.selectInstallationVersion({} as never),
      () => manager.archiveInstallation("installation"),
      () => manager.listEligibleExperienceSkills("installation"),
      () => manager.prepareExperienceCandidate({} as never),
      () => manager.submitExperienceCandidate({} as never),
      () => manager.listMyExperienceCandidates(),
      () => manager.listExperienceReviewQueue(),
      () => manager.getExperienceCandidate("candidate"),
      () => manager.reviewExperienceCandidate({} as never),
      () => manager.prepareExperienceCandidateImport("candidate"),
      () => manager.confirmExperienceCandidateImport({} as never),
    ];

    for (const operation of operations) {
      await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
        code: "organization_agent_not_enabled",
      });
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(clientCall).not.toHaveBeenCalled();
    expect(profileCall).not.toHaveBeenCalled();
    expect(bindingCall).not.toHaveBeenCalled();
    expect(runtimeVersion).not.toHaveBeenCalled();

    database.close();
  });

  it("does not interrupt an already installed Hermes Profile turn", async () => {
    const prepared = {
      binding: { id: "30000000-0000-4000-8000-000000000001" },
      profilePath: "/local/hermes-profile",
      resumeSessionId: null,
      envelope: {
        instructions: "fixed",
        requireBoundApiTransport: true,
      },
    };
    const prepareInstalledTurn = vi.fn(async () => prepared);
    const manager = new AgenteraAgentControlManager({
      profileBindings: {
        verifyProfileBinding: vi.fn(() => ({
          tenantId: OWNER.tenantId,
          ownerScope: "USER",
          ownerId: OWNER.ownerId,
          deviceInstallationId: OWNER.deviceInstallationId,
          agentInstallationId: "40000000-0000-4000-8000-000000000001",
          runtimeProfileId: "50000000-0000-4000-8000-000000000001",
          boundAt: "2026-07-21T00:00:00.000Z",
        })),
      } as never,
      hermesAdapter: {
        prepareInstalledTurn,
      } as unknown as AgenteraHermesAdapter,
      getAgentContext: () => ({
        scope: "ORGANIZATION_UNAVAILABLE",
        organizationId: ORGANIZATION_ID,
        role: "member",
      }),
    });
    const input = {
      conversationKey: "existing-conversation",
      profilePath: "/local/hermes-profile",
      owner: OWNER,
      resumeSessionId: null,
    };

    await expect(manager.prepareHermesTurn(input)).resolves.toBe(prepared);
    expect(prepareInstalledTurn).toHaveBeenCalledWith(input);
  });
});
