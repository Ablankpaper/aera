import type { AgenteraRuntimeOwner } from "./agentera-profile-binding";
import type { FrozenAgentModelRoute } from "./agentera-agent-control/frozen-agent-model-route";
import {
  parseFrozenAgentModelRoute,
  sessionModelOverrideFromFrozenRoute,
} from "./agentera-agent-control/frozen-agent-model-route";
import type { PreparedAgenteraConversationSegmentTransition } from "./agentera-agent-control/manager";
import type { ChatCallbacks } from "./hermes";
import type {
  AgentConversationSegmentEvent,
  PublicModelRouteIdentity,
} from "../shared/model-configuration";
import type { SessionModelOverride } from "../shared/model-override";
import { isLocalBaseUrl } from "../shared/url-key-map";

export type FrozenAgentExecutionRoute = FrozenAgentModelRoute;
export type AgentModelSegmentTransition =
  PreparedAgenteraConversationSegmentTransition;

export type AgentModelExecutionLeaseErrorCode =
  | "model_switch_source_unavailable"
  | "model_switch_route_drift"
  | "model_switch_credential_unavailable"
  | "model_switch_remote_unavailable";

export class AgentModelExecutionLeaseError extends Error {
  readonly code: AgentModelExecutionLeaseErrorCode;

  constructor(code: AgentModelExecutionLeaseErrorCode) {
    super(`Aera Agent model execution failed: ${code}.`);
    this.name = "AgentModelExecutionLeaseError";
    this.code = code;
  }
}

export interface AgentModelExecution {
  modelOverride: SessionModelOverride;
  apiMode: string | null;
  credential: string | null;
  routeMode: "configured" | "dynamic";
  disableTransportReplay: boolean;
}

export interface AgentModelExecutionLease {
  readonly publicIdentity: Readonly<PublicModelRouteIdentity>;
  run<T>(
    callback: (execution: AgentModelExecution) => T | Promise<T>,
  ): Promise<T>;
}

export interface CreateAgentModelExecutionLeaseInput {
  route: FrozenAgentExecutionRoute;
  mode?: "local" | "remote" | "ssh";
  routeMode?: "configured" | "dynamic";
  disableTransportReplay?: boolean;
  verifySourceProfile?: (
    sourceProfileId: string,
    modelLibraryId: string,
  ) => boolean | Promise<boolean>;
  resolveSourceRoute?: (
    sourceProfileId: string,
    modelLibraryId: string,
  ) =>
    | FrozenAgentExecutionRoute
    | null
    | Promise<FrozenAgentExecutionRoute | null>;
  getSecret?: (credentialRef: string, sourceProfileId: string) => string | null;
  routeAvailable?:
    | boolean
    | ((route: PublicModelRouteIdentity) => boolean | Promise<boolean>);
}

function publicIdentity(
  route: FrozenAgentExecutionRoute,
): PublicModelRouteIdentity {
  return {
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    apiMode: route.apiMode,
  };
}

function sameFrozenRoute(
  left: FrozenAgentExecutionRoute,
  right: FrozenAgentExecutionRoute,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Resolve one immutable Agent route at the last Main-process boundary before
 * transport setup. The lease never retains a credential value: a fresh value
 * exists only on the callback object and is cleared in `finally`.
 */
export function createAgentModelExecutionLease(
  input: CreateAgentModelExecutionLeaseInput,
): AgentModelExecutionLease {
  const route = parseFrozenAgentModelRoute(input.route);
  const identity = Object.freeze(publicIdentity(route));
  const mode = input.mode ?? "local";

  return {
    publicIdentity: identity,
    async run<T>(
      callback: (execution: AgentModelExecution) => T | Promise<T>,
    ): Promise<T> {
      if (mode !== "local") {
        const available =
          typeof input.routeAvailable === "function"
            ? await input.routeAvailable(identity)
            : input.routeAvailable === true;
        if (!available) {
          throw new AgentModelExecutionLeaseError(
            "model_switch_remote_unavailable",
          );
        }
      }

      if (!route.legacy) {
        const sourceProfileId = route.sourceProfileId!;
        const modelLibraryId = route.modelLibraryId!;
        if (
          input.verifySourceProfile &&
          !(await input.verifySourceProfile(sourceProfileId, modelLibraryId))
        ) {
          throw new AgentModelExecutionLeaseError(
            "model_switch_source_unavailable",
          );
        }
        if (input.resolveSourceRoute) {
          const current = await input.resolveSourceRoute(
            sourceProfileId,
            modelLibraryId,
          );
          if (
            current === null ||
            !sameFrozenRoute(route, parseFrozenAgentModelRoute(current))
          ) {
            throw new AgentModelExecutionLeaseError("model_switch_route_drift");
          }
        }
      }

      let credential: string | null = null;
      if (mode === "local" && route.credentialRef !== null) {
        credential =
          input.getSecret?.(route.credentialRef, route.sourceProfileId ?? "") ??
          null;
        if (!credential?.trim()) {
          throw new AgentModelExecutionLeaseError(
            "model_switch_credential_unavailable",
          );
        }
      } else if (
        mode === "local" &&
        !route.legacy &&
        route.credentialRef === null &&
        !isLocalBaseUrl(route.baseUrl)
      ) {
        throw new AgentModelExecutionLeaseError(
          "model_switch_credential_unavailable",
        );
      }

      const execution: AgentModelExecution = {
        modelOverride: sessionModelOverrideFromFrozenRoute(route),
        apiMode: route.apiMode,
        credential,
        routeMode: input.routeMode ?? "configured",
        disableTransportReplay: input.disableTransportReplay ?? false,
      };
      try {
        return await callback(execution);
      } finally {
        execution.credential = null;
        credential = null;
      }
    },
  };
}

interface AgentModelSegmentControl {
  attachConversationRuntimeSession(input: {
    runtimeBindingId: string | null;
    boundaryId: string;
    sessionId: string;
    owner: AgenteraRuntimeOwner;
    segmentId?: string | null;
  }): unknown;
  activateConversationSegment(input: {
    threadId: string;
    segmentId: string;
    expectedThreadRevision: number;
    owner: AgenteraRuntimeOwner;
  }): unknown;
  failConversationSegment(input: {
    threadId: string;
    segmentId: string;
    expectedThreadRevision: number;
    owner: AgenteraRuntimeOwner;
    code: string;
  }): unknown;
}

export interface CreateAgentModelSegmentLifecycleInput {
  transition: AgentModelSegmentTransition;
  owner: AgenteraRuntimeOwner;
  control: AgentModelSegmentControl;
  emit: (event: AgentConversationSegmentEvent) => void;
}

export interface AgentModelSegmentLifecycle {
  emitPreparing(): void;
  fail(error: unknown): void;
  readonly callbacks: Partial<ChatCallbacks>;
  readonly activated: boolean;
  readonly failed: boolean;
}

function segmentEvent(
  transition: AgentModelSegmentTransition,
  state: AgentConversationSegmentEvent["state"],
  code: string | null,
): AgentConversationSegmentEvent {
  return {
    state,
    threadId: transition.threadId,
    segmentId: transition.segmentId,
    from: transition.from,
    to: transition.to,
    historyBoundaryCount: transition.historyBoundaryCount,
    code,
  };
}

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^model_switch_[a-z0-9_]{1,96}$/.test(error.code)
  ) {
    return error.code;
  }
  return "model_switch_transport_failed";
}

/**
 * Candidate lifecycle state shared by the real send callbacks and focused IPC
 * tests. Activation is idempotent and always happens before an irreversible
 * content/reasoning/tool callback is forwarded by the caller.
 */
export function createAgentModelSegmentLifecycle(
  input: CreateAgentModelSegmentLifecycleInput,
): AgentModelSegmentLifecycle {
  let preparingEmitted = false;
  let attachedSessionId = "";
  let isActivated = false;
  let isFailed = false;

  const emitPreparing = (): void => {
    if (preparingEmitted) return;
    preparingEmitted = true;
    input.emit(segmentEvent(input.transition, "preparing", null));
  };

  const attach = (sessionId: string): void => {
    if (!sessionId || attachedSessionId === sessionId) return;
    input.control.attachConversationRuntimeSession({
      runtimeBindingId: input.transition.runtimeBindingId,
      boundaryId: input.transition.boundaryId,
      sessionId,
      owner: input.owner,
      segmentId: input.transition.segmentId,
    });
    attachedSessionId = sessionId;
  };

  const activate = (): void => {
    if (isActivated || isFailed) return;
    input.control.activateConversationSegment({
      threadId: input.transition.threadId,
      segmentId: input.transition.segmentId,
      expectedThreadRevision: input.transition.expectedThreadRevision,
      owner: input.owner,
    });
    isActivated = true;
    input.emit(segmentEvent(input.transition, "active", null));
  };

  const fail = (error: unknown): void => {
    if (isActivated || isFailed) return;
    const code = safeFailureCode(error);
    input.control.failConversationSegment({
      threadId: input.transition.threadId,
      segmentId: input.transition.segmentId,
      expectedThreadRevision: input.transition.expectedThreadRevision,
      owner: input.owner,
      code,
    });
    isFailed = true;
    input.emit(segmentEvent(input.transition, "failed", code));
  };

  const callbacks: Partial<ChatCallbacks> = {
    onSessionStarted: attach,
    onChunk: () => activate(),
    onReasoningChunk: () => activate(),
    onToolProgress: () => activate(),
    onToolEvent: () => activate(),
    onDone: (sessionId) => {
      if (sessionId) attach(sessionId);
      activate();
    },
    onError: fail,
  };

  return {
    emitPreparing,
    fail,
    callbacks,
    get activated() {
      return isActivated;
    },
    get failed() {
      return isFailed;
    },
  };
}

/**
 * Compose the candidate lifecycle with the normal transport callbacks. Main
 * activates the candidate before forwarding the first irreversible event, but
 * still forwards post-activation transport errors to the existing renderer.
 */
export function composeAgentModelSegmentCallbacks(
  base: ChatCallbacks,
  lifecycle: AgentModelSegmentLifecycle | null,
): ChatCallbacks {
  if (!lifecycle) return base;
  const lifecycleCallbacks = lifecycle.callbacks;
  return {
    ...base,
    onChunk: (chunk) => {
      lifecycleCallbacks.onChunk?.(chunk);
      base.onChunk(chunk);
    },
    onReasoningChunk: base.onReasoningChunk
      ? (chunk) => {
          lifecycleCallbacks.onReasoningChunk?.(chunk);
          base.onReasoningChunk?.(chunk);
        }
      : undefined,
    onSessionStarted: (sessionId) => {
      lifecycleCallbacks.onSessionStarted?.(sessionId);
      base.onSessionStarted?.(sessionId);
    },
    onToolProgress: base.onToolProgress
      ? (tool) => {
          lifecycleCallbacks.onToolProgress?.(tool);
          base.onToolProgress?.(tool);
        }
      : undefined,
    onToolEvent: base.onToolEvent
      ? (event) => {
          lifecycleCallbacks.onToolEvent?.(event);
          base.onToolEvent?.(event);
        }
      : undefined,
    onDone: (sessionId) => {
      lifecycleCallbacks.onDone?.(sessionId);
      base.onDone(sessionId);
    },
    onError: (error) => {
      lifecycleCallbacks.onError?.(error);
      base.onError(error);
    },
  };
}
