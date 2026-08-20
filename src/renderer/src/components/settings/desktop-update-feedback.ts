import type {
  DesktopUpdateCodeV2,
  DesktopUpdateStageV2,
} from "../../../../shared/desktop-update";

export interface DesktopUpdateFeedback {
  messageKey: string;
  actionKey: string;
}

const FEEDBACK: Partial<Record<DesktopUpdateCodeV2, DesktopUpdateFeedback>> = {
  update_origin_unavailable: {
    messageKey: "settings.updateOriginUnavailable",
    actionKey: "settings.updateContactSupport",
  },
  update_metadata_unavailable: {
    messageKey: "settings.updateMetadataUnavailable",
    actionKey: "settings.updateRetry",
  },
  update_metadata_invalid: {
    messageKey: "settings.updateMetadataInvalid",
    actionKey: "settings.updateContactSupport",
  },
  update_artifact_unavailable: {
    messageKey: "settings.updateDownloadFailed",
    actionKey: "settings.updateRetry",
  },
  update_artifact_size_mismatch: {
    messageKey: "settings.updateSizeMismatch",
    actionKey: "settings.updateRetry",
  },
  update_artifact_hash_mismatch: {
    messageKey: "settings.updateHashMismatch",
    actionKey: "settings.updateContactSupport",
  },
  update_signature_invalid: {
    messageKey: "settings.updateSignatureInvalid",
    actionKey: "settings.updateContactSupport",
  },
  update_redirect_rejected: {
    messageKey: "settings.updateRedirectRejected",
    actionKey: "settings.updateContactSupport",
  },
  update_extract_failed: {
    messageKey: "settings.updateExtractionFailed",
    actionKey: "settings.updateRetry",
  },
  update_staged_identity_invalid: {
    messageKey: "settings.updateStagingFailed",
    actionKey: "settings.updateContactSupport",
  },
  update_staged_native_invalid: {
    messageKey: "settings.updateNativeStagingFailed",
    actionKey: "settings.updateContactSupport",
  },
  update_swap_failed: {
    messageKey: "settings.updateSwapFailed",
    actionKey: "settings.updateRestart",
  },
  update_launch_failed: {
    messageKey: "settings.updateLaunchFailed",
    actionKey: "settings.updateRestart",
  },
  update_health_timeout: {
    messageKey: "settings.updateHealthFailed",
    actionKey: "settings.updateRestart",
  },
  update_rollback_failed: {
    messageKey: "settings.updateRollbackFailed",
    actionKey: "settings.updateContactSupport",
  },
  update_client_bridge_required: {
    messageKey: "settings.updateUnsupportedClient",
    actionKey: "settings.updateInstallManually",
  },
  update_cancelled: {
    messageKey: "settings.updateCancelled",
    actionKey: "settings.updateRetry",
  },
};

const UNKNOWN_FEEDBACK: DesktopUpdateFeedback = {
  messageKey: "settings.updateUnknownFailure",
  actionKey: "settings.updateContactSupport",
};

/** Map a closed or future updater code to safe localized keys. */
export function desktopUpdateFeedback(
  code: DesktopUpdateCodeV2 | string | null | undefined,
): DesktopUpdateFeedback {
  if (typeof code !== "string") return UNKNOWN_FEEDBACK;
  return FEEDBACK[code as DesktopUpdateCodeV2] ?? UNKNOWN_FEEDBACK;
}

/**
 * Project a durable stage event onto the legacy button state. Metadata success
 * is intentionally not projected because it may mean either available or
 * up-to-date; the Main snapshot remains authoritative for that distinction.
 */
export function projectDesktopUpdateState(
  event: DesktopUpdateStageV2,
): "checking" | "downloading" | "ready" | "error" | null {
  if (event.state === "failed" || event.state === "rolled_back") return "error";
  if (event.stage === "metadata" && event.state === "started") {
    return "checking";
  }
  if (
    event.stage === "verify" &&
    event.targetVersion === null &&
    (event.state === "started" || event.state === "succeeded")
  ) {
    return "checking";
  }
  if (
    (event.stage === "download" ||
      event.stage === "verify" ||
      event.stage === "extract" ||
      event.stage === "stage") &&
    (event.state === "started" || event.state === "succeeded")
  ) {
    return event.stage === "stage" && event.state === "succeeded"
      ? "ready"
      : "downloading";
  }
  return null;
}

export function desktopUpdateStageKey(
  stage: DesktopUpdateStageV2["stage"] | string,
): string {
  const known = new Set([
    "metadata",
    "download",
    "verify",
    "extract",
    "stage",
    "swap",
    "launch",
    "health",
    "finalize",
    "rollback",
  ]);
  return known.has(stage)
    ? `settings.updateStage.${stage}`
    : "settings.updateStage.unknown";
}
