// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgenteraHermesAdapter } from "../src/main/agentera-agent-control/hermes-adapter";
import { AgenteraAgentControlManager } from "../src/main/agentera-agent-control/manager";
import type {
  AgenteraProfileBindingStore,
  AgenteraRuntimeOwner,
  RuntimeOwnerBinding,
} from "../src/main/agentera-profile-binding";

const owner: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};

function profileBinding(
  agentInstallationId: string | null,
): RuntimeOwnerBinding {
  return {
    tenantId: owner.tenantId,
    ownerScope: "USER",
    ownerId: owner.ownerId,
    deviceInstallationId: owner.deviceInstallationId,
    agentInstallationId,
    runtimeProfileId: "44444444-4444-4444-8444-444444444444",
    boundAt: "2026-07-19T21:30:00.000Z",
  };
}

describe("RuntimeBinding integration at the main-process conversation boundary", () => {
  it("leaves an uninstalled Profile on the unchanged Hermes path", async () => {
    const verifyProfileBinding = vi.fn(() => profileBinding(null));
    const prepareInstalledTurn = vi.fn();
    const manager = new AgenteraAgentControlManager({
      profileBindings: {
        verifyProfileBinding,
      } as unknown as AgenteraProfileBindingStore,
      hermesAdapter: {
        prepareInstalledTurn,
      } as unknown as AgenteraHermesAdapter,
    });

    await expect(
      manager.prepareHermesTurn({
        conversationKey: "run-legacy",
        profilePath: "/tmp/profile",
        owner,
        resumeSessionId: null,
      }),
    ).resolves.toBeNull();
    expect(prepareInstalledTurn).not.toHaveBeenCalled();
  });

  it("routes an installed Profile through the adapter without exposing owner selection to the renderer", async () => {
    const installationId = "55555555-5555-4555-8555-555555555555";
    const prepared = {
      binding: { id: "66666666-6666-4666-8666-666666666666" },
      profilePath: "/tmp/profile",
      resumeSessionId: "desk-original",
      envelope: {
        instructions: "fixed",
        requireBoundApiTransport: true,
      },
    };
    const prepareInstalledTurn = vi.fn(async () => prepared);
    const manager = new AgenteraAgentControlManager({
      profileBindings: {
        verifyProfileBinding: vi.fn(() => profileBinding(installationId)),
      } as unknown as AgenteraProfileBindingStore,
      hermesAdapter: {
        prepareInstalledTurn,
      } as unknown as AgenteraHermesAdapter,
    });
    const input = {
      conversationKey: "run-installed",
      profilePath: "/tmp/profile",
      owner,
      resumeSessionId: "desk-original",
    };

    await expect(manager.prepareHermesTurn(input)).resolves.toBe(prepared);
    expect(prepareInstalledTurn).toHaveBeenCalledWith(input);
  });

  it("delivers only the sanitized RuntimeBinding outbox without blocking or failing the Hermes turn", async () => {
    const installationId = "55555555-5555-4555-8555-555555555555";
    const prepared = {
      binding: { id: "66666666-6666-4666-8666-666666666666" },
      profilePath: "/tmp/profile",
      envelope: {
        instructions: "fixed",
        requireBoundApiTransport: true,
      },
    };
    let rejectDelivery: ((error: Error) => void) | null = null;
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const retryPendingRuntimeBindings = vi.fn(() => delivery);
    const manager = new AgenteraAgentControlManager({
      profileBindings: {
        verifyProfileBinding: vi.fn(() => profileBinding(installationId)),
      } as unknown as AgenteraProfileBindingStore,
      hermesAdapter: {
        prepareInstalledTurn: vi.fn(async () => prepared),
      } as unknown as AgenteraHermesAdapter,
      retryPendingRuntimeBindings,
    });

    await expect(
      manager.prepareHermesTurn({
        conversationKey: "run-installed-outbox",
        profilePath: "/tmp/profile",
        owner,
        resumeSessionId: null,
      }),
    ).resolves.toBe(prepared);
    expect(retryPendingRuntimeBindings).toHaveBeenCalledTimes(1);

    rejectDelivery?.(new Error("cloud unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("resolves and validates the installed binding before starting or invoking Hermes", () => {
    const source = readFileSync(
      join(__dirname, "../src/main/ipc/register.ts"),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf('ipcMain.handle(\n    "send-message"'),
      source.indexOf('ipcMain.handle("abort-chat"'),
    );
    expect(handler.indexOf("prepareConversationRuntime")).toBeGreaterThan(-1);
    expect(handler.indexOf("prepareConversationRuntime")).toBeLessThan(
      handler.indexOf("startGateway(profile)"),
    );
    expect(handler.indexOf("prepareConversationRuntime")).toBeLessThan(
      handler.indexOf("await sendMessage("),
    );
    expect(handler).not.toContain("prepareHermesTurn(");
    expect(handler).not.toContain("prepareConversationBoundary(");
    expect(handler).toContain("preparedAgentTurn?.resumeSessionId");
    expect(handler).toContain("preparedAgentTurn?.envelope");
    expect(handler).toContain("attachConversationRuntimeSession(");
  });
});
