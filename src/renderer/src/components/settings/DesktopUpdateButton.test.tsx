import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateButton, desktopUpdateFeedback } from "./AboutPane";
import type { DesktopUpdateStageV2 } from "../../../../shared/desktop-update";

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.version ? `${key}:${String(options.version)}` : key,
  }),
}));

function failedEvent(
  code: string,
  stage: DesktopUpdateStageV2["stage"],
): DesktopUpdateStageV2 {
  return {
    schemaVersion: 2,
    operationId: "op-0123456789ab",
    stage,
    state: "failed",
    code: code as DesktopUpdateStageV2["code"],
    retryability: "retryable",
    diagnosticId: "0123456789ab",
    targetVersion: "0.7.4-internal-beta.33",
  };
}

describe("Desktop updater renderer feedback", () => {
  it.each([
    ["update_origin_unavailable", "settings.updateOriginUnavailable"],
    ["update_metadata_invalid", "settings.updateMetadataInvalid"],
    ["update_artifact_hash_mismatch", "settings.updateHashMismatch"],
    ["update_signature_invalid", "settings.updateSignatureInvalid"],
    ["update_extract_failed", "settings.updateExtractionFailed"],
    ["update_staged_identity_invalid", "settings.updateStagingFailed"],
    ["update_swap_failed", "settings.updateSwapFailed"],
    ["update_launch_failed", "settings.updateLaunchFailed"],
    ["update_health_timeout", "settings.updateHealthFailed"],
    ["update_rollback_failed", "settings.updateRollbackFailed"],
    ["update_client_bridge_required", "settings.updateUnsupportedClient"],
  ])("keeps %s distinct from generic failure", (code, messageKey) => {
    expect(desktopUpdateFeedback(code).messageKey).toBe(messageKey);
    expect(desktopUpdateFeedback(code).messageKey).not.toBe(
      "settings.updateUnknownFailure",
    );
  });

  it("uses an honest generic fallback for an unknown future code", () => {
    expect(desktopUpdateFeedback("future_update_code")).toEqual({
      messageKey: "settings.updateUnknownFailure",
      actionKey: "settings.updateContactSupport",
    });
  });

  it("shows the target, stage, action, and diagnostic id for a failed update", () => {
    render(
      <DesktopUpdateButton
        state="error"
        version="0.7.4-internal-beta.33"
        percent={null}
        stageEvent={failedEvent("update_origin_unavailable", "metadata")}
        onCheck={vi.fn()}
        onAct={vi.fn()}
      />,
    );

    expect(screen.getByText("settings.updateOriginUnavailable")).toBeVisible();
    expect(screen.getByText("settings.updateStage.metadata")).toBeVisible();
    expect(screen.getByText("settings.updateContactSupport")).toBeVisible();
    expect(screen.getByText("0123456789ab")).toBeVisible();
    expect(screen.getByText(/0\.7\.4-internal-beta\.33/u)).toBeVisible();
  });

  it("states that the previous app was restored after rollback", () => {
    render(
      <DesktopUpdateButton
        state="error"
        version="0.7.4-internal-beta.33"
        percent={null}
        stageEvent={{
          ...failedEvent("update_health_timeout", "health"),
          state: "rolled_back",
        }}
        onCheck={vi.fn()}
        onAct={vi.fn()}
      />,
    );

    expect(screen.getByText("settings.updateRolledBack")).toBeVisible();
    expect(screen.getByText("settings.updateUseCurrentVersion")).toBeVisible();
    expect(screen.queryByText("settings.updateInstalled")).toBeNull();
  });
});
