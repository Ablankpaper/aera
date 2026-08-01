import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentCreationGuide } from "./useAgentCreationGuide";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";

function installAPI(): {
  getState: ReturnType<typeof vi.fn>;
  createDraft: ReturnType<typeof vi.fn>;
} {
  const getState = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      access: "online",
      cloudAvailable: true,
      context: { scope: "USER" },
      draftCount: 0,
      installationCount: 0,
    },
  });
  const createDraft = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      id: "20000000-0000-4000-8000-000000000002",
      displayName: "林二",
    },
  });
  Object.defineProperty(window, "agenteraAgents", {
    configurable: true,
    value: { getState, createDraft },
  });
  return { getState, createDraft };
}

describe("useAgentCreationGuide", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a real Agent draft in the captured product context", async () => {
    const api = installAPI();
    const { result } = renderHook(() => useAgentCreationGuide());

    act(() => {
      expect(
        result.current.intercept(
          "帮我创建一个叫林二的智能体，负责整理客户资料",
          "turn-one",
        ),
      ).toBe(true);
    });
    await waitFor(() =>
      expect(result.current.guideMessages[0]?.status).toBe("pending"),
    );

    await act(async () => {
      await result.current.confirm("agent-creation-guide-turn-one", {
        name: "林二",
        purpose: "整理客户资料",
      });
    });

    expect(api.createDraft).toHaveBeenCalledOnce();
    expect(api.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentDefinitionId: null,
        baseAgentVersionId: null,
        displayName: "林二",
        icon: null,
        assets: [],
        manifest: expect.objectContaining({
          schemaVersion: 2,
          identity: {
            systemPrompt: expect.stringContaining("整理客户资料"),
          },
          modelPolicy: {
            mode: "user_select",
            allowedProviders: [],
            allowedModels: [],
          },
        }),
      }),
    );
    expect(result.current.guideMessages[0]).toMatchObject({
      status: "created",
      createdName: "林二",
    });
  });

  it("rejects a write when the selected work context changed after recognition", async () => {
    const api = installAPI();
    const { result } = renderHook(() => useAgentCreationGuide());

    act(() => {
      result.current.intercept("创建一个客服智能体", "turn-two");
    });
    await waitFor(() =>
      expect(result.current.guideMessages[0]?.status).toBe("pending"),
    );
    api.getState.mockResolvedValueOnce({
      ok: true,
      data: {
        access: "online",
        cloudAvailable: true,
        context: {
          scope: "WORKSPACE",
          workspaceId: WORKSPACE_ID,
          role: "admin",
        },
        draftCount: 0,
        installationCount: 0,
      },
    });

    await act(async () => {
      await result.current.confirm("agent-creation-guide-turn-two", {
        name: "客服",
        purpose: "",
      });
    });

    expect(api.createDraft).not.toHaveBeenCalled();
    expect(result.current.guideMessages[0]).toMatchObject({
      status: "error",
      errorCode: "context_changed",
    });
  });

  it("does not intercept messages with attachments or non-creation questions", () => {
    installAPI();
    const { result } = renderHook(() => useAgentCreationGuide());

    expect(
      result.current.intercept("创建一个图片分析智能体", "turn-three", [
        {
          id: "attachment-one",
          name: "screen.png",
          kind: "image",
          size: 20,
          path: "/tmp/screen.png",
        },
      ] as never),
    ).toBe(false);
    expect(result.current.intercept("如何创建智能体？", "turn-four")).toBe(
      false,
    );
    expect(result.current.guideMessages).toEqual([]);
  });
});
