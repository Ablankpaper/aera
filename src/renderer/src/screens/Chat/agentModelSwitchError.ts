/**
 * Stable, renderer-safe copy for an Agent model-switch failure.
 *
 * Main may attach diagnostic details to an Error object, but those details can
 * contain paths, provider responses, or other private data. Only the small
 * allow-list below is allowed to cross into user-facing copy; unknown values
 * intentionally fall back to the existing generic message.
 */
const MODEL_SWITCH_ERROR_KEYS = {
  model_switch_source_unavailable: "chat.modelSwitch.sourceUnavailable",
  model_switch_route_drift: "chat.modelSwitch.routeDrift",
  model_switch_route_ambiguous: "chat.modelSwitch.routeAmbiguous",
  model_switch_credential_unavailable: "chat.modelSwitch.credentialUnavailable",
  model_switch_remote_unavailable: "chat.modelSwitch.remoteUnavailable",
  model_switch_owner_changed: "chat.modelSwitch.ownerChanged",
  model_switch_runtime_route_unsupported:
    "chat.modelSwitch.runtimeRouteUnsupported",
  model_switch_transport_failed: "chat.modelSwitch.transportFailed",
  provider_authentication_rejected:
    "chat.modelSwitch.providerAuthenticationRejected",
} as const;

export type AgentModelSwitchErrorCode = keyof typeof MODEL_SWITCH_ERROR_KEYS;

function isKnownCode(value: unknown): value is AgentModelSwitchErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(MODEL_SWITCH_ERROR_KEYS, value)
  );
}

function codeFromText(value: string): AgentModelSwitchErrorCode | null {
  for (const code of Object.keys(MODEL_SWITCH_ERROR_KEYS)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (
      new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "iu").test(value)
    ) {
      return code as AgentModelSwitchErrorCode;
    }
  }
  return null;
}

/** Extract only an allow-listed code from an arbitrary Main error value. */
export function modelSwitchErrorCode(
  error: unknown,
): AgentModelSwitchErrorCode | null {
  if (isKnownCode(error)) return error;
  if (typeof error === "string") return codeFromText(error);
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (isKnownCode(code)) return code;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? codeFromText(message) : null;
}

/** Return an i18n key, never raw Main error text. */
export function modelSwitchErrorKey(error: unknown): string {
  const code = modelSwitchErrorCode(error);
  return code
    ? MODEL_SWITCH_ERROR_KEYS[code]
    : "chat.modelSwitch.failedKeepsCurrent";
}
