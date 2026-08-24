import type { ChatErrorCode, ChatErrorEvent } from "../shared/chat-error";

const KNOWN_RUNTIME_CODES = [
  "provider_authentication_rejected",
  "model_switch_runtime_route_unsupported",
  "agent_tool_policy_runtime_unsupported",
  "bound_runtime_unavailable",
] as const satisfies readonly ChatErrorCode[];

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return `${typeof code === "string" ? code : ""} ${error.message}`;
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function containsCode(value: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "iu").test(value);
}

/** Reduce arbitrary Runtime/provider text to one renderer-safe stable code. */
export function classifyRendererChatError(error: unknown): ChatErrorEvent {
  const text = errorText(error);
  for (const code of KNOWN_RUNTIME_CODES) {
    if (containsCode(text, code)) return { code };
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b|socket hang up|bound runtime connection is unavailable/iu.test(
      text,
    )
  ) {
    return { code: "chat_transport_unavailable" };
  }
  return { code: "chat_runtime_failed" };
}

/**
 * Create the value used to reject the `send-message` IPC Promise.
 *
 * The event channel and the invoke/rejection channel must have the same
 * privacy boundary.  Never put the original Runtime/provider text in the
 * rejection: Electron serializes it back to the Renderer independently of
 * the `chat-error` event.  Keep the stable code as an enumerable property so
 * model-switch presentation can still select localized copy.
 */
export function rendererChatErrorRejection(event: ChatErrorEvent): Error & {
  code: ChatErrorEvent["code"];
} {
  return Object.assign(new Error(event.code), { code: event.code });
}

/** Safe system-notification copy; never includes provider or local details. */
export function rendererChatErrorNotificationBody(
  event: ChatErrorEvent,
): string {
  return event.code === "provider_authentication_rejected"
    ? "The model provider rejected the current credential."
    : "The chat request failed.";
}
