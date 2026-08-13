import { describe, expect, it, vi } from "vitest";
import {
  composeAgentModelSegmentCallbacks,
  createAgentModelSegmentLifecycle,
  type AgentModelSegmentTransition,
} from "../agent-model-execution-lease";
import type { ChatCallbacks } from "../hermes";
import type { PreparedAgenteraConversationRuntime } from "../agentera-agent-control/manager";
import {
  classifyAgentModelRoute,
  prepareAgentModelSend,
  runAgentModelSegmentPreflight,
} from "./agent-model-send";

const transition: AgentModelSegmentTransition = {
  kind: "candidate",
  threadId: "11111111-1111-4111-8111-111111111111",
  segmentId: "22222222-2222-4222-8222-222222222222",
  runtimeBindingId: "33333333-3333-4333-8333-333333333333",
  boundaryId: "44444444-4444-4444-8444-444444444444",
  expectedThreadRevision: 3,
  from: {
    provider: "openai",
    model: "gpt-5.6",
    baseUrl: "",
    apiMode: "responses",
  },
  to: {
    provider: "custom:petoi",
    model: "gpt-5.6-sol",
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "codex_responses",
  },
  historyBoundaryCount: 2,
};

function lifecycleHarness(): {
  control: {
    attachConversationRuntimeSession: ReturnType<typeof vi.fn>;
    activateConversationSegment: ReturnType<typeof vi.fn>;
    failConversationSegment: ReturnType<typeof vi.fn>;
  };
  events: unknown[];
  lifecycle: ReturnType<typeof createAgentModelSegmentLifecycle>;
} {
  const control = {
    attachConversationRuntimeSession: vi.fn(),
    activateConversationSegment: vi.fn(),
    failConversationSegment: vi.fn(),
  };
  const events: unknown[] = [];
  const lifecycle = createAgentModelSegmentLifecycle({
    transition,
    owner: {
      tenantId: "55555555-5555-4555-8555-555555555555",
      ownerId: "66666666-6666-4666-8666-666666666666",
      deviceInstallationId: "77777777-7777-4777-8777-777777777777",
    },
    control,
    emit: (event) => events.push(event),
  });
  return { control, events, lifecycle };
}

describe("installed-Agent send IPC segment lifecycle", () => {
  it("uses the configured transport only when the frozen route exactly matches the active profile", () => {
    expect(
      classifyAgentModelRoute(transition.to, {
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
      }),
    ).toBe("configured");
    expect(
      classifyAgentModelRoute(transition.to, {
        provider: "openai",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("dynamic");
  });

  it("passes the opaque selection and visible history count to Manager", async () => {
    const prepareConversationRuntime = vi.fn<
      (input: never) => Promise<PreparedAgenteraConversationRuntime>
    >(async () => ({
      preparedAgentTurn: null,
      conversationBoundary: {
        id: "boundary",
      } as unknown as PreparedAgenteraConversationRuntime["conversationBoundary"],
      agentConversation: null,
      agentSegmentId: null,
      segmentTransition: null,
    }));
    const selection = {
      sourceProfileId: "account-home",
      modelLibraryId: "petoi-gpt",
      catalogRevision: "a".repeat(64),
    };

    await prepareAgentModelSend({
      control: { prepareConversationRuntime },
      conversationKey: "profile\0run",
      profilePath: "/profiles/agent",
      owner: {
        tenantId: "55555555-5555-4555-8555-555555555555",
        ownerId: "66666666-6666-4666-8666-666666666666",
        deviceInstallationId: "77777777-7777-4777-8777-777777777777",
      },
      resumeSessionId: "old-session",
      history: [
        { role: "user", content: "one" },
        { role: "agent", content: "two" },
        { role: "system", content: "not visible" },
      ],
      requestedModelSelection: selection,
    });

    expect(prepareConversationRuntime).toHaveBeenCalledWith({
      conversationKey: "profile\0run",
      profilePath: "/profiles/agent",
      owner: expect.any(Object),
      resumeSessionId: "old-session",
      requestedModelSelection: selection,
      visibleHistoryCount: 2,
    });
  });

  it("keeps the old segment active when candidate setup fails before output", () => {
    const { control, events, lifecycle } = lifecycleHarness();
    lifecycle.emitPreparing();
    lifecycle.callbacks.onError?.("connect failed");

    expect(control.failConversationSegment).toHaveBeenCalledTimes(1);
    expect(control.activateConversationSegment).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ state: "preparing" }),
      expect.objectContaining({
        state: "failed",
        code: "model_switch_transport_failed",
      }),
    ]);
  });

  it("fails the candidate when send preflight rejects and preserves the original error", async () => {
    const { control, events, lifecycle } = lifecycleHarness();
    const startupError = new Error("gateway startup failed");

    await expect(
      runAgentModelSegmentPreflight(lifecycle, async () => {
        throw startupError;
      }),
    ).rejects.toBe(startupError);

    expect(control.failConversationSegment).toHaveBeenCalledTimes(1);
    expect(control.activateConversationSegment).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ state: "preparing" }),
      expect.objectContaining({
        state: "failed",
        code: "model_switch_transport_failed",
      }),
    ]);
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Just-in-time route and credential lease]]
  it("preserves a bounded execution-lease failure code before activation", () => {
    const { control, events, lifecycle } = lifecycleHarness();
    lifecycle.emitPreparing();
    lifecycle.fail({ code: "model_switch_credential_unavailable" });

    expect(control.failConversationSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "model_switch_credential_unavailable",
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        state: "failed",
        code: "model_switch_credential_unavailable",
      }),
    );
  });

  it("activates once before forwarding the first tool event and never replays", () => {
    const { control, events, lifecycle } = lifecycleHarness();
    lifecycle.emitPreparing();
    lifecycle.callbacks.onSessionStarted?.("hermes-new");
    lifecycle.callbacks.onToolEvent?.({
      callId: "call-1",
      name: "search",
      status: "running",
    });
    lifecycle.callbacks.onError?.("provider disconnected");

    expect(control.activateConversationSegment).toHaveBeenCalledTimes(1);
    expect(control.failConversationSegment).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) => (event as { state?: string }).state === "active",
      ),
    ).toHaveLength(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({ state: "active" }));
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Real transport activation boundary]]
  it("activates before forwarding irreversible output and preserves the transport error", () => {
    const { control, lifecycle } = lifecycleHarness();
    const order: string[] = [];
    control.activateConversationSegment.mockImplementation(() => {
      order.push("activate");
    });
    const base: ChatCallbacks = {
      onChunk: () => order.push("chunk"),
      onDone: () => order.push("done"),
      onError: () => order.push("error"),
      onToolEvent: () => order.push("tool"),
    };

    const callbacks = composeAgentModelSegmentCallbacks(base, lifecycle);
    callbacks.onToolEvent?.({
      callId: "call-2",
      name: "search",
      status: "running",
    });
    callbacks.onError("provider disconnected");

    expect(order).toEqual(["activate", "tool", "error"]);
    expect(control.activateConversationSegment).toHaveBeenCalledTimes(1);
    expect(control.failConversationSegment).not.toHaveBeenCalled();
  });

  it("fails a preparing candidate before forwarding a startup error", () => {
    const { control, lifecycle } = lifecycleHarness();
    const order: string[] = [];
    const base: ChatCallbacks = {
      onChunk: () => order.push("chunk"),
      onDone: () => order.push("done"),
      onError: () => order.push("error"),
    };

    const callbacks = composeAgentModelSegmentCallbacks(base, lifecycle);
    callbacks.onError("connect failed");

    expect(control.failConversationSegment).toHaveBeenCalledTimes(1);
    expect(control.activateConversationSegment).not.toHaveBeenCalled();
    expect(order).toEqual(["error"]);
  });
});
