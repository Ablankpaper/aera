// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { LocalCapabilityBinding } from "./capability-binding-store";
import { CapabilityBindingService } from "./capability-binding-service";
import type {
  CapabilityBindingInstallation,
  CapabilityBindingServiceOptions,
} from "./capability-binding-service";

const INSTALLATION_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000002";
const VERSION_ID = "10000000-0000-4000-8000-000000000003";
const MAPPING_HANDLE = "10000000-0000-4000-8000-000000000004";

function serviceOptions(): {
  bindings: LocalCapabilityBinding[];
  upsert: ReturnType<typeof vi.fn>;
  getInstallation: ReturnType<typeof vi.fn>;
  resumePendingInstallation: ReturnType<typeof vi.fn>;
  options: CapabilityBindingServiceOptions;
} {
  const bindings: LocalCapabilityBinding[] = [];
  const upsert = vi.fn((input) => {
    const binding: LocalCapabilityBinding = {
      agentInstallationId: input.agentInstallationId,
      requirementLogicalName: input.requirementLogicalName,
      localMcpName: input.localMcpName,
      verifiedTools: [...input.verifiedTools],
      revision: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
    bindings.push(binding);
    return binding;
  });
  const getInstallation = vi.fn<() => CapabilityBindingInstallation>(() => ({
    agentInstallationId: INSTALLATION_ID,
    selectedVersionId: VERSION_ID,
    runtimeProfileId: PROFILE_ID,
    status: "pending" as const,
    retryCode: "profile_capability_configuration_required",
  }));
  const resumePendingInstallation = vi.fn<
    () => Promise<CapabilityBindingInstallation>
  >(async () => ({
    ...getInstallation(),
    status: "active" as const,
    retryCode: null,
  }));
  return {
    bindings,
    upsert,
    getInstallation,
    resumePendingInstallation,
    options: {
      getOwnerKey: () => "owner\0device",
      getInstallation,
      getVerifiedVersion: () => ({
        id: VERSION_ID,
        manifest: {
          schema_version: 3 as const,
          mcp_requirements: [
            {
              logical_name: "private-docs",
              tools: ["docs.read", "docs.search"],
              required: true,
              permission_reason: "Read employee-approved documents",
            },
            {
              logical_name: "calendar-optional",
              tools: ["calendar.read"],
              required: false,
              permission_reason: "Read an optional calendar",
            },
          ],
        },
      }),
      resolveProfilePath: () => "/private/employee-profile",
      listCapabilityServers: async () => [
        {
          name: "employee-docs",
          enabled: true,
          tools: ["docs.search", "docs.read", "unrequested.tool"],
        },
        {
          name: "author-private-server",
          enabled: false,
          tools: [],
        },
      ],
      bindingStore: {
        list: vi.fn(() => [...bindings]),
        upsert,
      },
      resumePendingInstallation,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      randomUUID: () => MAPPING_HANDLE,
    },
  };
}

describe("CapabilityBindingService", () => {
  it("lists only logical requirements and compatible local MCP display names", async () => {
    const setup = serviceOptions();
    const service = new CapabilityBindingService(setup.options);

    const configuration = await service.list(INSTALLATION_ID);

    expect(configuration).toEqual({
      installationId: INSTALLATION_ID,
      requirements: [
        {
          logicalName: "private-docs",
          tools: ["docs.read", "docs.search"],
          required: true,
          permissionReason: "Read employee-approved documents",
          mappedLocalMcpName: null,
          compatibleServers: [
            {
              mappingHandle: MAPPING_HANDLE,
              displayName: "employee-docs",
              current: false,
            },
          ],
        },
        {
          logicalName: "calendar-optional",
          tools: ["calendar.read"],
          required: false,
          permissionReason: "Read an optional calendar",
          mappedLocalMcpName: null,
          compatibleServers: [],
        },
      ],
    });
    expect(JSON.stringify(configuration)).not.toMatch(
      /private\/employee-profile|url|command|args|env|header|token|auth/i,
    );
  });

  it("revalidates an opaque handle, binds required tools, and resumes the pending Installation", async () => {
    const setup = serviceOptions();
    const service = new CapabilityBindingService(setup.options);
    await service.list(INSTALLATION_ID);

    const result = await service.confirm({
      installationId: INSTALLATION_ID,
      mappingHandles: [MAPPING_HANDLE],
      confirmation: "bind-profile-capabilities",
    });

    expect(setup.upsert).toHaveBeenCalledWith({
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: PROFILE_ID,
      requirementLogicalName: "private-docs",
      localMcpName: "employee-docs",
      verifiedTools: ["docs.read", "docs.search"],
      expectedRevision: null,
    });
    expect(setup.resumePendingInstallation).toHaveBeenCalledWith(
      INSTALLATION_ID,
    );
    expect(result).toMatchObject({
      installation: { status: "active", retryCode: null },
      forceNewConversation: true,
    });
    await expect(
      service.confirm({
        installationId: INSTALLATION_ID,
        mappingHandles: [MAPPING_HANDLE],
        confirmation: "bind-profile-capabilities",
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
  });
});
