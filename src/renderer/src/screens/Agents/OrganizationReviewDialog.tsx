import { useEffect, useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionSummary,
  OrganizationReviewPreview,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface OrganizationReviewDialogProps {
  open: boolean;
  detail: OrganizationAgentSubmissionDetail;
  initialPreview?: OrganizationReviewPreview | null;
  onClose: () => void;
  onCompleted: (submission: OrganizationAgentSubmissionSummary) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function OrganizationReviewDialog({
  open,
  detail,
  initialPreview = null,
  onClose,
  onCompleted,
}: OrganizationReviewDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<OrganizationReviewPreview | null>(
    initialPreview,
  );
  const [reasonCode, setReasonCode] = useState("");
  const [safeNote, setSafeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(initialPreview);
    setReasonCode("");
    setSafeNote("");
    setBusy(false);
    setError(null);
    setNotice(null);
  }, [detail.summary.id, initialPreview, open]);

  const lockedDetail = preview?.detail ?? detail;

  const prepare = async (decision: "approve" | "reject"): Promise<void> => {
    if (busy || preview) return;
    if (decision === "reject" && !reasonCode) return;
    const normalizedSafeNote = safeNote.replace(/[\r\n\0]/g, " ").trim();
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.prepareOrganizationReview({
      submissionId: detail.summary.id,
      decision,
      reasonCode: decision === "reject" ? reasonCode : null,
      safeNote:
        decision === "reject" && normalizedSafeNote ? normalizedSafeNote : null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setPreview(result.data);
  };

  const confirm = async (): Promise<void> => {
    if (busy || !preview?.reviewHandle) return;
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmOrganizationReview({
      reviewHandle: preview.reviewHandle,
      confirmation:
        preview.decision === "approve"
          ? "approve-organization-agent"
          : "reject-organization-agent",
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setNotice(
      preview.decision === "approve"
        ? "agents.control.organization.approvedNotInstalled"
        : "agents.control.organization.rejectedNotPublished",
    );
    onCompleted(result.data);
  };

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      className="agent-control-modal"
      labelledBy="organization-review-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="organization-review-dialog-title">
            {t("agents.control.organization.reviewTitle")}
          </AppModalTitle>
          <p>{t("agents.control.organization.immutableReviewPackage")}</p>
        </div>
        <button
          type="button"
          className="agents-row-edit"
          aria-label={t("agents.control.close")}
          onClick={onClose}
          disabled={busy}
        >
          <X size={16} />
        </button>
      </header>

      <div className="agent-control-modal-body">
        <h4>{lockedDetail.displayName ?? lockedDetail.summary.definitionId}</h4>
        <dl className="agent-control-preview-grid">
          <dt>{t("agents.control.organization.status")}</dt>
          <dd>
            {t(
              `agents.control.organization.statusValue.${lockedDetail.summary.status}`,
            )}
          </dd>
          <dt>{t("agents.control.organization.contentDigest")}</dt>
          <dd>{lockedDetail.summary.contentDigest}</dd>
          <dt>{t("agents.control.organization.baseVersion")}</dt>
          <dd>
            {lockedDetail.summary.baseVersionId ??
              t("agents.control.organization.initialVersion")}
          </dd>
          <dt>{t("agents.control.asset.skill")}</dt>
          <dd>{lockedDetail.assetCounts.skill}</dd>
          <dt>{t("agents.control.asset.sop")}</dt>
          <dd>{lockedDetail.assetCounts.sop}</dd>
          <dt>{t("agents.control.asset.knowledge")}</dt>
          <dd>{lockedDetail.assetCounts.knowledge}</dd>
          <dt>{t("agents.control.totalBytes")}</dt>
          <dd>{lockedDetail.totalBytes}</dd>
        </dl>

        <section className="agent-control-assets">
          <h4>{t("agents.control.versionAssets")}</h4>
          {lockedDetail.assets.map((asset) => (
            <article key={asset.path} className="agent-control-card">
              <div>
                <strong>{asset.path}</strong>
                <p>
                  {t(`agents.control.asset.${asset.kind}`)} · {asset.sizeBytes}
                </p>
              </div>
            </article>
          ))}
        </section>

        <p className="agent-control-private-boundary">
          {t("agents.control.organization.policyAndDlpPassed")}
        </p>
        <p className="agent-control-private-boundary">
          {t("agents.control.organization.runtimeBoundary")}
        </p>

        {!preview ? (
          <div className="agent-control-group">
            <label className="agents-create-field">
              <span>{t("agents.control.experience.rejectionReason")}</span>
              <select
                className="input"
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
              >
                <option value="">
                  {t("agents.control.experience.chooseReason")}
                </option>
                <option value="insufficient_quality">
                  {t("agents.control.experience.reason.insufficient_quality")}
                </option>
                <option value="wrong_scope">
                  {t("agents.control.experience.reason.wrong_scope")}
                </option>
                <option value="policy_blocked">
                  {t("agents.control.experience.reason.policy_blocked")}
                </option>
              </select>
            </label>
            <label className="agents-create-field">
              <span>{t("agents.control.experience.safeNote")}</span>
              <input
                className="input"
                value={safeNote}
                maxLength={500}
                onChange={(event) => setSafeNote(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {error ? <div className="agents-create-error">{t(error)}</div> : null}
        {notice ? (
          <div className="agent-control-success">{t(notice)}</div>
        ) : null}
      </div>

      <footer className="agent-control-modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("agents.control.close")}
        </button>
        {!preview ? (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !reasonCode}
              onClick={() => void prepare("reject")}
            >
              {t("agents.control.organization.reject")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void prepare("approve")}
            >
              {t("agents.control.organization.approve")}
            </button>
          </>
        ) : preview.reviewHandle ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || notice !== null}
            onClick={() => void confirm()}
          >
            {t(
              preview.decision === "approve"
                ? "agents.control.organization.confirmApproval"
                : "agents.control.organization.confirmRejection",
            )}
          </button>
        ) : null}
      </footer>
    </AppModal>
  );
}
