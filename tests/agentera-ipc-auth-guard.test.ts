// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTERA_IPC_CHANNEL_POLICY,
  AGENTERA_PROFILE_ARGUMENT_INDEX,
  createGuardedIpcMain,
  createProductAccessGuard,
  type ProductAccessLevel,
} from "../src/main/ipc/auth-guard";

function registeredChannels(): string[] {
  const filePath = join(__dirname, "../src/main/ipc/register.ts");
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const channels: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ipcMain" &&
      (node.expression.name.text === "handle" ||
        node.expression.name.text === "on")
    ) {
      const first = node.arguments[0];
      if (!first || !ts.isStringLiteralLike(first)) {
        throw new Error(
          "Every ipcMain registration must use a literal channel.",
        );
      }
      channels.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(channels)].sort();
}

function registeredProfileArguments(): Record<string, number> {
  const filePath = join(__dirname, "../src/main/ipc/register.ts");
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result: Record<string, number> = {};
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ipcMain" &&
      node.expression.name.text === "handle"
    ) {
      const channel = node.arguments[0];
      const listener = node.arguments[1];
      if (
        channel &&
        ts.isStringLiteralLike(channel) &&
        listener &&
        (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))
      ) {
        const profileIndex = listener.parameters.findIndex((parameter) =>
          /^_?profile$/i.test(parameter.name.getText(source)),
        );
        if (profileIndex >= 1) result[channel.text] = profileIndex - 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

describe("AgentEra central IPC product-access guard", () => {
  it("assigns exactly one explicit access level to every IPC channel", () => {
    const channels = registeredChannels();
    expect(channels.length).toBeGreaterThan(100);
    expect(Object.keys(AGENTERA_IPC_CHANNEL_POLICY).sort()).toEqual(channels);
    for (const level of Object.values(AGENTERA_IPC_CHANNEL_POLICY)) {
      expect(["preflight", "authenticated", "bound-profile"]).toContain(level);
    }
  });

  it("tracks the renderer argument position of every explicit Profile target", () => {
    expect(AGENTERA_PROFILE_ARGUMENT_INDEX).toEqual(
      registeredProfileArguments(),
    );
  });

  it("keeps preflight limited to sanitized bootstrap, install probes, app metadata, locale, and product auth", () => {
    const preflight = Object.entries(AGENTERA_IPC_CHANNEL_POLICY)
      .filter(([, level]) => level === "preflight")
      .map(([channel]) => channel)
      .sort();
    expect(preflight).toEqual(
      [
        "agentera-auth-cancel-login",
        "agentera-auth-get-state",
        "agentera-auth-logout",
        "agentera-auth-retry-online",
        "agentera-auth-start-login",
        "agentera-install-file-probe",
        "agentera-startup-preflight",
        "get-gpu-status",
        "get-locale",
        "quit-app",
        "relaunch-app",
        "set-locale",
      ].sort(),
    );
    expect(AGENTERA_IPC_CHANNEL_POLICY["start-install"]).toBe("authenticated");
    expect(AGENTERA_IPC_CHANNEL_POLICY["check-install"]).toBe("authenticated");
    expect(AGENTERA_IPC_CHANNEL_POLICY["get-connection-config"]).toBe(
      "authenticated",
    );
    expect(AGENTERA_IPC_CHANNEL_POLICY["send-message"]).toBe("bound-profile");
    expect(AGENTERA_IPC_CHANNEL_POLICY["list-sessions"]).toBe("bound-profile");
    expect(AGENTERA_IPC_CHANNEL_POLICY["read-memory"]).toBe("bound-profile");
    expect(AGENTERA_IPC_CHANNEL_POLICY["list-installed-skills"]).toBe(
      "bound-profile",
    );
  });

  it("asserts authorization before invoking a Runtime handler", async () => {
    const registrations = new Map<string, (...args: unknown[]) => unknown>();
    const rawIpc = {
      handle: vi.fn(
        (channel: string, listener: (...args: unknown[]) => unknown) => {
          registrations.set(channel, listener);
        },
      ),
      on: vi.fn(),
    };
    const guard = { assert: vi.fn(() => void 0) };
    const ipc = createGuardedIpcMain(rawIpc, guard);
    const privateRead = vi.fn(() => "private result");
    ipc.handle("send-message", privateRead);

    guard.assert.mockImplementationOnce((level: ProductAccessLevel) => {
      expect(level).toBe("bound-profile");
      throw new Error("AgentEra Profile binding is required.");
    });
    await expect(async () => {
      await registrations.get("send-message")?.({});
    }).rejects.toThrow(/binding is required/i);
    expect(privateRead).not.toHaveBeenCalled();
  });

  it("asserts an explicit Profile target before invoking its handler", async () => {
    const registrations = new Map<string, (...args: unknown[]) => unknown>();
    const rawIpc = {
      handle: vi.fn(
        (channel: string, listener: (...args: unknown[]) => unknown) => {
          registrations.set(channel, listener);
        },
      ),
      on: vi.fn(),
    };
    const privateRead = vi.fn(() => "private result");
    const assertChannelArguments = vi.fn(() => {
      throw new Error("Runtime Profile belongs to another owner.");
    });
    const ipc = createGuardedIpcMain(
      rawIpc,
      { assert: vi.fn() },
      assertChannelArguments,
    );
    ipc.handle("read-memory", privateRead);

    await expect(async () => {
      await registrations.get("read-memory")?.({}, "other-profile");
    }).rejects.toThrow(/another owner/i);
    expect(assertChannelArguments).toHaveBeenCalledWith("read-memory", [
      "other-profile",
    ]);
    expect(privateRead).not.toHaveBeenCalled();
  });

  it("allows authenticated and bound levels only for the matching main-process state", () => {
    let status: "unauthenticated" | "authenticated" = "unauthenticated";
    let bound = false;
    const guard = createProductAccessGuard({
      getAuthState: () =>
        status === "authenticated"
          ? {
              status,
              userId: "11111111-1111-4111-8111-111111111111",
              personalSpaceId: "22222222-2222-4222-8222-222222222222",
              deviceId: "33333333-3333-4333-8333-333333333333",
              offlineExpiresAt: "2026-07-25T00:00:00.000Z",
              cloudAvailable: true,
            }
          : { status, reason: "sign_in_required" },
      isRuntimeContextBound: () => bound,
    });

    expect(() => guard.assert("preflight")).not.toThrow();
    expect(() => guard.assert("authenticated")).toThrow(/sign-in/i);
    status = "authenticated";
    expect(() => guard.assert("authenticated")).not.toThrow();
    expect(() => guard.assert("bound-profile")).toThrow(/binding/i);
    bound = true;
    expect(() => guard.assert("bound-profile")).not.toThrow();
  });
});
