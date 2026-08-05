export type StreamIntegrityProviderRequest =
  | { kind: "chat"; turn: number }
  | { kind: "auxiliary" }
  | { kind: "invalid" };

const CHAT_CASE_PATTERN = /^AERA_STREAM_INTEGRITY_CASE_(0[1-9]|1[0-9]|20)$/u;

export function classifyStreamIntegrityProviderRequest(
  value: unknown,
): StreamIntegrityProviderRequest {
  if (!value || typeof value !== "object") return { kind: "invalid" };
  const payload = value as { messages?: unknown; stream?: unknown };
  if (!Array.isArray(payload.messages)) return { kind: "invalid" };

  const lastUserMessage = payload.messages.findLast(
    (message): message is { content: unknown; role: "user" } =>
      Boolean(
        message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "user",
      ),
  );
  if (typeof lastUserMessage?.content !== "string") {
    return { kind: "invalid" };
  }

  const chatCase = CHAT_CASE_PATTERN.exec(lastUserMessage.content);
  if (chatCase) {
    return payload.stream === true
      ? { kind: "chat", turn: Number(chatCase[1]) }
      : { kind: "invalid" };
  }
  return payload.stream === true ? { kind: "invalid" } : { kind: "auxiliary" };
}
