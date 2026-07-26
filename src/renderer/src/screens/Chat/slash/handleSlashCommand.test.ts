import { describe, expect, it, vi } from "vitest";
import { createSlashCatalog } from "./commandCatalog";
import { DESKTOP_SLASH_COMMANDS } from "./desktopCommands";
import { handleSlashCommand } from "./handleSlashCommand";
import type { AgentSlashCommand, SlashCommandContext } from "./types";

function createMockContext(
  overrides?: Partial<SlashCommandContext>,
): SlashCommandContext {
  return {
    attachments: [],
    isModelBusy: false,
    executeAgentSlash: vi.fn().mockResolvedValue({ kind: "done" }),
    submitPrompt: vi.fn().mockResolvedValue(undefined),
    enqueuePrompt: vi.fn(),
    addSystemMessage: vi.fn(),
    executeDesktopSlash: vi.fn().mockResolvedValue(true),
    renderSlashHelp: vi.fn().mockReturnValue("help"),
    openSettings: vi.fn(),
    openDialog: vi.fn(),
    startNewChat: vi.fn(),
    clearTranscript: vi.fn(),
    renameAgent: vi.fn().mockResolvedValue({ success: true }),
    getGlobalProfile: vi.fn().mockResolvedValue({
      success: true,
      value: {
        schemaVersion: 1,
        profileVersion: 0,
        updatedAt: null,
        entries: [],
      },
    }),
    setGlobalProfileEntry: vi.fn().mockResolvedValue({
      success: true,
      value: {
        schemaVersion: 1,
        profileVersion: 1,
        updatedAt: null,
        entries: [],
      },
    }),
    removeGlobalProfileEntry: vi.fn(),
    listGlobalProfileHistory: vi.fn(),
    rollbackGlobalProfile: vi.fn(),
    ...overrides,
  };
}

describe("handleSlashCommand", () => {
  const agentCommands: AgentSlashCommand[] = [
    {
      name: "status",
      description: "Check status",
      category: "Agent",
      source: "agent",
      target: "agent",
      allowWhileBusy: true,
    },
  ];

  const catalog = createSlashCatalog({
    desktopCommands: DESKTOP_SLASH_COMMANDS,
    agentCommands,
    aliases: { c: "status" },
  });

  it("routes desktop command correctly", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/settings appearance", catalog, ctx);
    expect(res).toEqual({ type: "handled", output: undefined });
    expect(ctx.openSettings).toHaveBeenCalledWith("appearance");
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("renames the current Agent locally without submitting command text", async () => {
    const ctx = createMockContext({ profile: "agent-one" });
    const res = await handleSlashCommand("/agent name 小乌龟", catalog, ctx);

    expect(res).toEqual({
      type: "handled",
      output: "Agent renamed to “小乌龟”. The new identity is active now.",
    });
    expect(ctx.renameAgent).toHaveBeenCalledWith("agent-one", "小乌龟");
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
    expect(ctx.executeAgentSlash).not.toHaveBeenCalled();
  });

  it("writes an explicit global behavior entry locally without sending its value", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand(
      "/global set communication_style.preferred_address Use the chosen account-wide form of address",
      catalog,
      ctx,
    );

    expect(res).toMatchObject({ type: "handled" });
    expect(ctx.setGlobalProfileEntry).toHaveBeenCalledWith({
      id: "communication_style.preferred_address",
      category: "communication_style",
      content: "Use the chosen account-wide form of address",
    });
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
    expect(ctx.executeAgentSlash).not.toHaveBeenCalled();
  });

  it("runs desktop (uiAction) commands even when attachments are staged", async () => {
    // Desktop UI actions never consume attachments (they leave them in the
    // composer), so the attachment guard must not block them — otherwise
    // typing `/settings` with a file staged would error instead of running.
    const ctx = createMockContext({
      attachments: [{ id: "att-1" }] as SlashCommandContext["attachments"],
    });
    const res = await handleSlashCommand("/settings", catalog, ctx);
    expect(res).toEqual({ type: "handled", output: undefined });
    expect(ctx.openSettings).toHaveBeenCalled();
  });

  it("still rejects attachments for agent commands lacking support", async () => {
    const ctx = createMockContext({
      attachments: [{ id: "att-1" }] as SlashCommandContext["attachments"],
    });
    const res = await handleSlashCommand("/status", catalog, ctx);
    expect(res).toEqual({
      type: "error",
      message: "/status does not accept attachments",
    });
    expect(ctx.executeAgentSlash).not.toHaveBeenCalled();
  });

  it("routes agent command correctly via RPC", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/status", catalog, ctx);
    expect(res).toEqual({ type: "handled" });
    expect(ctx.executeAgentSlash).toHaveBeenCalledWith(
      "/status",
      ctx.addSystemMessage,
    );
  });

  it("routes model command correctly to submitPrompt", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand(
      "/explain-selection make it simple",
      catalog,
      ctx,
    );
    expect(res.type).toBe("submitted");
    expect(ctx.submitPrompt).toHaveBeenCalledTimes(1);
    expect(ctx.enqueuePrompt).not.toHaveBeenCalled();
  });

  it("formats an Agent send directive before submitting it", async () => {
    const ctx = createMockContext({
      executeAgentSlash: vi.fn().mockResolvedValue({
        kind: "send",
        message: "  expanded model prompt  ",
        source: "skill",
      }),
    });
    const res = await handleSlashCommand("/status", catalog, ctx);

    expect(res.type).toBe("submitted");
    expect(ctx.submitPrompt).toHaveBeenCalledWith({
      content: "expanded model prompt",
      attachments: [],
      metadata: {
        source: "slash-command",
        route: "agent-skill",
        command: "status",
      },
    });
  });

  it("queues model command when model is busy", async () => {
    const ctx = createMockContext({ isModelBusy: true });
    // explain-selection has allowWhileBusy: false, so let's register a custom busy-allowed model command
    const busyCatalog = createSlashCatalog({
      desktopCommands: [
        {
          name: "summarize",
          description: "sum",
          category: "Model",
          source: "desktop",
          target: "model",
          allowWhileBusy: true,
          format: async () => ({ content: "summarized" }),
        },
      ],
    });

    const res = await handleSlashCommand("/summarize", busyCatalog, ctx);
    expect(res.type).toBe("queued");
    expect(ctx.enqueuePrompt).toHaveBeenCalledTimes(1);
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("queues model command when busy even when it cannot execute concurrently", async () => {
    const ctx = createMockContext({ isModelBusy: true });
    const res = await handleSlashCommand("/explain-selection", catalog, ctx);
    expect(res.type).toBe("queued");
    expect(ctx.enqueuePrompt).toHaveBeenCalledTimes(1);
  });

  it("returns error for unknown command without hitting LLM", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/unknown-cmd", catalog, ctx);
    expect(res).toEqual({
      type: "error",
      message: "Unknown command: /unknown-cmd",
    });
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("resolves alias correctly", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/c", catalog, ctx);
    expect(res.type).toBe("handled");
    expect(ctx.executeAgentSlash).toHaveBeenCalledWith(
      "/c",
      ctx.addSystemMessage,
    );
  });
});
