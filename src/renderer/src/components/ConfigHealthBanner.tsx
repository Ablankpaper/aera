import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./useI18n";
import { X } from "lucide-react";

/**
 * Dismissible banner that surfaces config-health issues at the top of
 * the Chat tab. Renders nothing when the report has no issues or when
 * the user has already dismissed it for this session.
 *
 * Clicking "Show details" routes to Settings → Diagnose for the full
 * per-issue list + auto-fix controls. The banner itself only shows a
 * one-line summary count so it stays out of the user's way.
 */

interface ConfigHealthBannerProps {
  /** Active profile (forwarded to the audit IPC). */
  profile?: string;
  /** Open Settings → Diagnose section. */
  onOpenDiagnose?: () => void;
}

interface Report {
  profile?: string;
  issues: { code: string; severity: "error" | "warning" | "info" }[];
  summary: { errors: number; warnings: number; infos: number };
}

type LocalConnectionRepairState =
  | "idle"
  | "repairing"
  | "failed"
  | "not-applicable";

const DISMISS_STORAGE_KEY = "hermes-config-health-dismissed";
export const CONFIG_HEALTH_UPDATED_EVENT = "hermes-config-health-updated";

function readDismissedReportStamp(): number {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function rememberDismiss(ranAt: number): void {
  try {
    localStorage.setItem(DISMISS_STORAGE_KEY, String(ranAt));
  } catch {
    // localStorage can be unavailable in some sandboxed renderers
  }
}

function isReportForProfile(
  report: (Report & { ranAt: number }) | null,
  profile?: string,
): boolean {
  if (!report) return false;
  const expected = profile || "default";
  return !report.profile || report.profile === expected;
}

export function ConfigHealthBanner({
  profile,
  onOpenDiagnose,
}: ConfigHealthBannerProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [report, setReport] = useState<(Report & { ranAt: number }) | null>(
    null,
  );
  const [localConnectionRepair, setLocalConnectionRepair] =
    useState<LocalConnectionRepairState>("idle");
  const attemptedProfiles = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const r = (await window.hermesAPI.getConfigHealth(profile)) as
          | (Report & { ranAt: number })
          | null;
        if (!cancelled) setReport(r);
      } catch {
        // Silent — config-health is best-effort. No banner if it fails.
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [profile]);

  useEffect(() => {
    const onConfigHealthUpdated = (event: Event): void => {
      const next = (event as CustomEvent<Report & { ranAt: number }>).detail;
      if (isReportForProfile(next, profile)) {
        setReport(next);
      }
    };

    window.addEventListener(CONFIG_HEALTH_UPDATED_EVENT, onConfigHealthUpdated);
    return (): void => {
      window.removeEventListener(
        CONFIG_HEALTH_UPDATED_EVENT,
        onConfigHealthUpdated,
      );
    };
  }, [profile]);

  const hasEmptyApiKey =
    report?.issues.some((issue) => issue.code === "EMPTY_API_SERVER_KEY") ??
    false;

  const repairLocalConnection = useCallback(async (): Promise<void> => {
    setLocalConnectionRepair("repairing");
    try {
      const connection = await window.hermesAPI.getConnectionConfig();
      if (connection.mode !== "local") {
        // Remote and SSH connections own their authentication elsewhere.
        // A missing local gateway key is irrelevant in those modes.
        setLocalConnectionRepair("not-applicable");
        return;
      }

      let status = await window.hermesAPI.getApiServerKeyStatus(profile);
      if (!status.hasKey && status.providerId === "command") {
        // Advanced vault-backed profiles keep internal credentials outside
        // .env. Refresh the provider once, but never overwrite it.
        await window.hermesAPI.invalidateSecretsCache();
        status = await window.hermesAPI.getApiServerKeyStatus(profile);
      }

      if (!status.hasKey) {
        if (status.providerId === "command") {
          throw new Error(
            "The configured secrets provider has no gateway key.",
          );
        }
        try {
          await window.hermesAPI.generateApiServerKey(profile);
        } catch (error) {
          // Main persists the credential before restarting an already-running
          // gateway. A transient restart failure must not leave a stale
          // "missing credential" banner behind when the durable write itself
          // succeeded; confirm through the same resolver before treating the
          // repair as failed.
          status = await window.hermesAPI.getApiServerKeyStatus(profile);
          if (!status.hasKey) throw error;
        }
      }

      const next = (await window.hermesAPI.rerunConfigHealth(profile)) as
        | (Report & { ranAt: number })
        | null;
      if (
        !next ||
        next.issues.some((issue) => issue.code === "EMPTY_API_SERVER_KEY")
      ) {
        throw new Error("The local gateway key was not applied.");
      }

      setReport(next);
      setLocalConnectionRepair("idle");
    } catch {
      setLocalConnectionRepair("failed");
    }
  }, [profile]);

  useEffect(() => {
    if (!hasEmptyApiKey) return;
    const profileKey = profile || "default";
    if (attemptedProfiles.current.has(profileKey)) return;
    attemptedProfiles.current.add(profileKey);
    void repairLocalConnection();
  }, [hasEmptyApiKey, profile, repairLocalConnection]);

  if (!report || report.issues.length === 0) return null;

  const visibleIssues =
    localConnectionRepair === "not-applicable"
      ? report.issues.filter((issue) => issue.code !== "EMPTY_API_SERVER_KEY")
      : report.issues;
  if (visibleIssues.length === 0) return null;

  const visibleSummary = {
    errors: visibleIssues.filter((issue) => issue.severity === "error").length,
    warnings: visibleIssues.filter((issue) => issue.severity === "warning")
      .length,
    infos: visibleIssues.filter((issue) => issue.severity === "info").length,
  };

  // Only surface the banner for errors/warnings. Info-level issues are
  // visible in Settings → Diagnose but don't demand attention in the
  // chat header.
  if (visibleSummary.errors === 0 && visibleSummary.warnings === 0) return null;

  const dismissedAt = readDismissedReportStamp();
  if (dismissedAt >= report.ranAt) return null;

  const worstSeverity = visibleSummary.errors ? "error" : "warning";
  const summaryParts: string[] = [];
  if (visibleSummary.errors) {
    summaryParts.push(
      t("diagnose.banner.errors", { count: visibleSummary.errors }),
    );
  }
  if (visibleSummary.warnings) {
    summaryParts.push(
      t("diagnose.banner.warnings", { count: visibleSummary.warnings }),
    );
  }
  if (visibleSummary.infos && summaryParts.length === 0) {
    summaryParts.push(
      t("diagnose.banner.infos", { count: visibleSummary.infos }),
    );
  }
  const summary = summaryParts.join(", ");

  return (
    <div
      className={`config-health-banner config-health-banner-${worstSeverity}`}
      role="status"
      aria-live="polite"
      data-testid="config-health-banner"
    >
      <span className="config-health-banner-text">
        {hasEmptyApiKey
          ? localConnectionRepair === "failed"
            ? t("diagnose.localConnection.notReady")
            : t("diagnose.localConnection.preparing")
          : `${t("diagnose.banner.lead")} ${summary}.`}
      </span>
      <div className="config-health-banner-actions">
        {hasEmptyApiKey && localConnectionRepair === "failed" && (
          <button
            className="config-health-banner-link"
            type="button"
            onClick={() => void repairLocalConnection()}
          >
            {t("diagnose.localConnection.autoFix")}
          </button>
        )}
        {onOpenDiagnose && (
          <button
            className="config-health-banner-link"
            type="button"
            onClick={onOpenDiagnose}
          >
            {t("diagnose.banner.showDetails")}
          </button>
        )}
        <button
          className="config-health-banner-dismiss"
          type="button"
          aria-label={t("common.dismiss")}
          onClick={() => {
            rememberDismiss(report.ranAt);
            setReport(null);
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export default ConfigHealthBanner;
