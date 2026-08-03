// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("global-profile transport at the RuntimeBinding boundary", () => {
  it("keeps installed and renamed Agents off a transport that bypasses their conversation envelope", () => {
    const source = readFileSync(
      join(__dirname, "../src/main/ipc/register.ts"),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf(
        'ipcMain.handle(\n    "agentera-global-profile-conversation-context"',
      ),
      source.indexOf("const runtimeState = async"),
    );

    expect(handler).toContain("binding.agentInstallationId !== null");
    expect(handler).toContain("identityConversationKey !== runId");
    expect(handler).toContain("requiresBoundApiTransport:");
    expect(handler).toContain("prepareConversationRuntime({");
    expect(handler).not.toContain("prepareHermesTurn({");
    expect(handler).not.toContain("prepareConversationBoundary({");
    expect(handler).toContain("conversationBoundary,");
  });

  it("binds the frozen global-profile snapshot to the durable Hermes session id", () => {
    const source = readFileSync(
      join(__dirname, "../src/main/ipc/register.ts"),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf('ipcMain.handle(\n    "send-message"'),
      source.indexOf('ipcMain.handle("abort-chat"'),
    );

    expect(handler).toContain("resumeSession:");
    expect(handler).toContain("bindConversationSnapshotToSession(");
    expect(handler.indexOf("bindConversationSnapshotToSession(")).toBeLessThan(
      handler.indexOf('safeSend("chat-session-started"'),
    );
  });
});
