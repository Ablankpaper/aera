import { useEffect, useState } from "react";
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

const DISMISS_STORAGE_KEY = "hermes-config-health-dismissed";
export const CONFIG_HEALTH_UPDATED_EVENT = "hermes-config-health-updated";
const OBSOLETE_EMPTY_GATEWAY_KEY_ISSUE = "EMPTY_API_SERVER_KEY";

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

  if (!report || report.issues.length === 0) return null;

  // Older Main builds could report this issue even though Dashboard chat was
  // already healthy. Ignore it defensively during mixed-version/hot-reload
  // transitions; the legacy gateway generates its private credential in Main
  // at spawn time.
  const visibleIssues = report.issues.filter(
    (issue) => issue.code !== OBSOLETE_EMPTY_GATEWAY_KEY_ISSUE,
  );
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
        {`${t("diagnose.banner.lead")} ${summary}.`}
      </span>
      <div className="config-health-banner-actions">
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
