// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { runAgenteraStartupPreflight } from "../src/main/agentera-startup-preflight";
import type { ConnectionConfig } from "../src/main/config";

function connection(mode: "local" | "remote" | "ssh"): ConnectionConfig {
  return {
    mode,
    remoteUrl: "https://private-runtime.example",
    apiKey: "must-not-leave-main",
    remoteAuthMode: "token" as const,
    remoteChatTransport: "auto" as const,
    sshChatTransport: "auto" as const,
    connectionContextId: "11111111-1111-4111-8111-111111111111",
    ssh: {
      host: "private-ssh.example",
      port: 22,
      username: "private-user",
      keyPath: "/private/id_ed25519",
      remotePort: 8642,
      localPort: 18642,
    },
  };
}

describe("Aera sanitized startup preflight", () => {
  it.each([
    [{ installed: false, hasApiKey: false }, "welcome"],
    [{ installed: true, hasApiKey: false }, "main"],
    [{ installed: true, hasApiKey: true }, "main"],
  ] as const)("maps local install state to %s", async (install, target) => {
    const result = await runAgenteraStartupPreflight({
      getConnectionConfig: () => connection("local"),
      checkInstallStatus: () => ({ ...install, configured: install.hasApiKey }),
      verifyInstall: async () => true,
      probeRemote: vi.fn(),
      probeSsh: vi.fn(),
    });

    expect(result).toEqual({
      connectionMode: "local",
      postAuthTarget: target,
      verifyWarning: false,
    });
    expect(Object.keys(result).sort()).toEqual(
      ["connectionMode", "postAuthTarget", "verifyWarning"].sort(),
    );
  });

  it.each(["remote", "ssh"] as const)(
    "checks %s reachability without returning owner connection data",
    async (mode) => {
      const probeRemote = vi.fn(async () => false);
      const probeSsh = vi.fn(async () => false);
      const result = await runAgenteraStartupPreflight({
        getConnectionConfig: () => connection(mode),
        checkInstallStatus: vi.fn(),
        verifyInstall: vi.fn(),
        probeRemote,
        probeSsh,
      });

      expect(result).toEqual({
        connectionMode: mode,
        postAuthTarget: "main",
        verifyWarning: false,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(
        /private-runtime|private-ssh|private-user|id_ed25519|must-not-leave-main|connectionContextId/i,
      );
      expect(mode === "remote" ? probeRemote : probeSsh).toHaveBeenCalledOnce();
    },
  );

  it("turns a failed local deep verification into a soft warning", async () => {
    await expect(
      runAgenteraStartupPreflight({
        getConnectionConfig: () => connection("local"),
        checkInstallStatus: () => ({
          installed: true,
          configured: true,
          hasApiKey: true,
        }),
        verifyInstall: async () => false,
        probeRemote: vi.fn(),
        probeSsh: vi.fn(),
      }),
    ).resolves.toEqual({
      connectionMode: "local",
      postAuthTarget: "main",
      verifyWarning: true,
    });
  });
});
