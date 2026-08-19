import { describe, expect, it } from "vitest";
import {
  DESKTOP_UPDATE_CODES,
  DESKTOP_UPDATE_STAGES,
  desktopUpdateRetryability,
  desktopUpdateStageV2,
  parseDesktopUpdateStageV2,
  type DesktopUpdateCodeV2,
  type DesktopUpdateStageV2,
} from "./desktop-update";

const operationId = "op-0123456789ab";
const targetVersion = "0.7.4-internal-beta.33";

const cases: Array<
  [
    DesktopUpdateStageV2["stage"],
    DesktopUpdateCodeV2,
    DesktopUpdateStageV2["retryability"],
  ]
> = [
  ["metadata", "update_origin_unavailable", "after_user_action"],
  ["metadata", "update_metadata_unavailable", "retryable"],
  ["metadata", "update_metadata_invalid", "not_retryable"],
  ["download", "update_artifact_unavailable", "retryable"],
  ["verify", "update_artifact_size_mismatch", "retryable"],
  ["verify", "update_artifact_hash_mismatch", "retryable"],
  ["verify", "update_signature_invalid", "not_retryable"],
  ["download", "update_redirect_rejected", "not_retryable"],
  ["extract", "update_extract_failed", "retryable"],
  ["stage", "update_staged_identity_invalid", "not_retryable"],
  ["stage", "update_staged_native_invalid", "after_restart"],
  ["swap", "update_swap_failed", "after_restart"],
  ["launch", "update_launch_failed", "after_restart"],
  ["health", "update_health_timeout", "after_restart"],
  ["rollback", "update_rollback_failed", "not_retryable"],
  ["stage", "update_client_bridge_required", "after_user_action"],
  ["metadata", "update_cancelled", "retryable"],
];

describe("DesktopUpdateStageV2 contract", () => {
  it("keeps the exact closed stage and code registries", () => {
    expect(DESKTOP_UPDATE_STAGES).toEqual([
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
    expect(DESKTOP_UPDATE_CODES).toEqual([
      "update_origin_unavailable",
      "update_metadata_unavailable",
      "update_metadata_invalid",
      "update_artifact_unavailable",
      "update_artifact_size_mismatch",
      "update_artifact_hash_mismatch",
      "update_signature_invalid",
      "update_redirect_rejected",
      "update_extract_failed",
      "update_staged_identity_invalid",
      "update_staged_native_invalid",
      "update_swap_failed",
      "update_launch_failed",
      "update_health_timeout",
      "update_rollback_failed",
      "update_client_bridge_required",
      "update_cancelled",
    ]);
  });

  it.each(cases)(
    "assigns the owning stage and retryability for %s/%s",
    (stage, code, retryability) => {
      const event = desktopUpdateStageV2({
        operationId,
        stage,
        state: "failed",
        code,
        targetVersion,
        diagnosticId: "0123456789ab",
      });

      expect(event).toEqual({
        schemaVersion: 2,
        operationId,
        stage,
        state: "failed",
        code,
        retryability,
        diagnosticId: "0123456789ab",
        targetVersion,
      });
      expect(desktopUpdateRetryability(code)).toBe(retryability);
    },
  );

  it("generates an opaque lowercase diagnostic id when one is not supplied", () => {
    const event = desktopUpdateStageV2({
      operationId,
      stage: "metadata",
      state: "started",
      code: null,
      targetVersion: null,
    });

    expect(event.diagnosticId).toMatch(/^[0-9a-f]{12}$/u);
    expect(event.retryability).toBe("not_retryable");
  });

  it("rejects malformed IDs, unknown fields, and raw diagnostic material", () => {
    expect(() =>
      desktopUpdateStageV2({
        operationId,
        stage: "metadata",
        state: "failed",
        code: "update_metadata_invalid",
        targetVersion: null,
        diagnosticId: "not-an-id",
      }),
    ).toThrow(/diagnostic/i);

    expect(() =>
      desktopUpdateStageV2({
        operationId,
        stage: "metadata",
        state: "failed",
        code: "update_metadata_invalid",
        targetVersion: null,
        rawError: "https://updates.example/private?token=secret",
      } as never),
    ).toThrow(/field|payload|unknown/i);
  });

  it("parses only the exact secret-free envelope", () => {
    const event = desktopUpdateStageV2({
      operationId,
      stage: "rollback",
      state: "rolled_back",
      code: "update_health_timeout",
      targetVersion,
      diagnosticId: "abcdef012345",
    });
    expect(parseDesktopUpdateStageV2(event)).toEqual(event);
    expect(
      parseDesktopUpdateStageV2({ ...event, responseBody: "private" }),
    ).toBeNull();
    expect(parseDesktopUpdateStageV2({ ...event, code: "future_code" })).toBe(
      null,
    );
  });
});
