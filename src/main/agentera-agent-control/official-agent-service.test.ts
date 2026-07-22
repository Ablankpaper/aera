// @vitest-environment node

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  AgenteraAgentControlContext,
  OfficialAgentSummary,
} from "../../shared/agentera-agent-control";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { LocalAgentInstallation } from "./installation-manager";
import {
  OfficialAgentService,
  type OfficialAgentServiceClient,
  type OfficialAgentServiceInstaller,
} from "./official-agent-service";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const RELEASE_ID = "44444444-4444-4444-8444-444444444444";
const RELEASE_REVISION_ID = "55555555-5555-4555-8555-555555555555";
const HANDLE_ID = "66666666-6666-4666-8666-666666666666";
const WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-07-22T00:00:00.000Z");

function summary(
  overrides: Partial<OfficialAgentSummary> = {},
): OfficialAgentSummary {
  return {
    definitionId: DEFINITION_ID,
    displayName: "Official Research Agent",
    iconMediaType: null,
    iconDataBase64Url: null,
    versionId: VERSION_ID,
    versionNumber: 1,
    releaseId: RELEASE_ID,
    releaseRevisionId: RELEASE_REVISION_ID,
    channel: "internal",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    installationState: "not_installed",
    updateState: "current",
    ...overrides,
  };
}

function installed(): LocalAgentInstallation {
  return {
    agentInstallationId: INSTALLATION_ID,
    sourceScope: "PLATFORM",
    sourceWorkspaceId: null,
    sourceOrganizationId: null,
    officialReleaseId: RELEASE_ID,
    selectedReleaseRevisionId: RELEASE_REVISION_ID,
    updatePolicy: "managed",
    definitionId: DEFINITION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: "88888888-8888-4888-8888-888888888888",
    policySnapshotId: "99999999-9999-4999-8999-999999999999",
    status: "active",
    retryCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe("OfficialAgentService", () => {
  let online = true;
  let owner: AgenteraRuntimeOwner;
  let context: AgenteraAgentControlContext;
  let channel: "internal" | "stable";
  let client: OfficialAgentServiceClient;
  let installer: OfficialAgentServiceInstaller;
  let listOfficialAgents: Mock<
    OfficialAgentServiceClient["listOfficialAgents"]
  >;
  let getOfficialRelease: Mock<
    OfficialAgentServiceClient["getOfficialRelease"]
  >;
  let install: Mock<OfficialAgentServiceInstaller["install"]>;

  beforeEach(() => {
    online = true;
    owner = {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceInstallationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    context = { scope: "USER" };
    channel = "internal";
    listOfficialAgents = vi
      .fn<OfficialAgentServiceClient["listOfficialAgents"]>()
      .mockResolvedValue([summary()]);
    getOfficialRelease = vi
      .fn<OfficialAgentServiceClient["getOfficialRelease"]>()
      .mockResolvedValue(summary());
    install = vi
      .fn<OfficialAgentServiceInstaller["install"]>()
      .mockResolvedValue(installed());
    client = {
      listOfficialAgents,
      getOfficialRelease,
      getOfficialAgentChannel: () => channel,
    };
    installer = { install };
  });

  function service(): OfficialAgentService {
    return new OfficialAgentService({
      client,
      installer,
      getOwner: () => owner,
      getContext: () => context,
      isOnline: () => online,
      now: () => NOW,
      randomUUID: () => HANDLE_ID,
    });
  }

  it("lists safe summaries and consumes an exact release-bound install handle once", async () => {
    const subject = service();
    await expect(subject.list()).resolves.toEqual([summary()]);
    const preview = await subject.prepareInstall(DEFINITION_ID);
    expect(preview).toEqual({
      installHandle: HANDLE_ID,
      agent: summary(),
      expiresAt: "2026-07-22T00:05:00.000Z",
    });

    await expect(
      subject.confirmInstall({
        installHandle: HANDLE_ID,
        confirmation: "install-official-agent",
      }),
    ).resolves.toEqual(installed());
    expect(getOfficialRelease).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledWith({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      source: {
        scope: "PLATFORM",
        officialReleaseId: RELEASE_ID,
        selectedReleaseRevisionId: RELEASE_REVISION_ID,
        updatePolicy: "managed",
      },
      profile: { kind: "fresh", name: "Official Research Agent" },
    });
    await expect(
      subject.confirmInstall({
        installHandle: HANDLE_ID,
        confirmation: "install-official-agent",
      }),
    ).rejects.toMatchObject({ code: "official_install_handle_invalid" });
  });

  it("invalidates prepared handles when account, device, context, or channel changes", async () => {
    for (const mutate of [
      () => {
        owner = { ...owner, ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
      },
      () => {
        owner = {
          ...owner,
          deviceInstallationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        };
      },
      () => {
        context = {
          scope: "WORKSPACE",
          workspaceId: WORKSPACE_ID,
          role: "member",
        };
      },
      () => {
        channel = "stable";
      },
    ]) {
      owner = {
        tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        deviceInstallationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      };
      context = { scope: "USER" };
      channel = "internal";
      const subject = service();
      await subject.prepareInstall(DEFINITION_ID);
      mutate();
      await expect(
        subject.confirmInstall({
          installHandle: HANDLE_ID,
          confirmation: "install-official-agent",
        }),
      ).rejects.toMatchObject({ code: "official_install_handle_invalid" });
    }
    expect(install).not.toHaveBeenCalled();
  });

  it("re-fetches the release and refuses a stale or offline confirmation", async () => {
    const subject = service();
    await subject.prepareInstall(DEFINITION_ID);
    getOfficialRelease.mockResolvedValueOnce(
      summary({
        releaseRevisionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    );
    await expect(
      subject.confirmInstall({
        installHandle: HANDLE_ID,
        confirmation: "install-official-agent",
      }),
    ).rejects.toMatchObject({ code: "official_release_changed" });
    expect(install).not.toHaveBeenCalled();

    online = false;
    await expect(subject.list()).rejects.toMatchObject({
      code: "online_required",
    });
    await expect(subject.prepareInstall(DEFINITION_ID)).rejects.toMatchObject({
      code: "online_required",
    });
  });
});
