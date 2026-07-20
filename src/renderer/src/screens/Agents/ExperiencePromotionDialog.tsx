import { useEffect, useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  AgenteraAgentInstallationSummary,
  EligibleExperienceSkill,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface ExperiencePromotionDialogProps {
  open: boolean;
  installation: AgenteraAgentInstallationSummary;
  agentName: string;
  online: boolean;
  onClose: () => void;
  onSubmitted: (candidate: ExperienceCandidateSummary) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function ExperiencePromotionDialog({
  open,
  installation,
  agentName,
  online,
  onClose,
  onSubmitted,
}: ExperiencePromotionDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<EligibleExperienceSkill[]>([]);
  const [skillName, setSkillName] = useState("");
  const [preview, setPreview] = useState<ExperienceCandidatePreview | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSkills([]);
    setSkillName("");
    setPreview(null);
    setConfirmed(false);
    setUploadFailed(false);
    setError(null);
    setLoadingSkills(true);
    void window.agenteraAgents
      .listEligibleExperienceSkills(installation.id)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setError(errorKey(result.errorCode));
          return;
        }
        setSkills(result.data);
      })
      .catch(() => {
        if (active) setError("agents.control.errors.operation_failed");
      })
      .finally(() => {
        if (active) setLoadingSkills(false);
      });
    return () => {
      active = false;
    };
  }, [installation.id, open]);

  const prepare = async (): Promise<void> => {
    if (!skillName || preparing) return;
    setPreparing(true);
    setError(null);
    setPreview(null);
    setConfirmed(false);
    setUploadFailed(false);
    try {
      const result = await window.agenteraAgents.prepareExperienceCandidate({
        installationId: installation.id,
        skillName,
      });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setPreview(result.data);
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setPreparing(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (
      !preview ||
      !online ||
      preview.findings.length > 0 ||
      !confirmed ||
      submitting
    ) {
      return;
    }
    setSubmitting(true);
    setUploadFailed(false);
    setError(null);
    try {
      const result = await window.agenteraAgents.submitExperienceCandidate({
        candidateId: preview.localCandidateId,
        confirmation: "submit-selected-skill",
      });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        setUploadFailed(true);
        return;
      }
      onSubmitted(result.data);
    } catch {
      setError("agents.control.errors.operation_failed");
      setUploadFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    preview !== null &&
    preview.findings.length === 0 &&
    online &&
    confirmed &&
    !submitting;

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !preparing && !submitting) onClose();
      }}
      className="agent-control-modal"
      labelledBy="experience-promotion-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="experience-promotion-dialog-title">
            {t("agents.control.experience.promotionTitle")}
          </AppModalTitle>
          <p>{t("agents.control.experience.promotionSubtitle")}</p>
        </div>
        <button
          type="button"
          className="agents-row-edit"
          aria-label={t("agents.control.close")}
          onClick={onClose}
          disabled={preparing || submitting}
        >
          <X size={16} />
        </button>
      </header>

      <div className="agent-control-modal-body">
        <p className="agent-control-private-boundary">
          {t("agents.control.experience.privateBoundary")}
        </p>

        <label className="agents-create-field">
          <span>{t("agents.control.experience.skill")}</span>
          <select
            className="input"
            aria-label={t("agents.control.experience.skill")}
            value={skillName}
            disabled={loadingSkills || preparing || submitting}
            onChange={(event) => {
              setSkillName(event.target.value);
              setPreview(null);
              setConfirmed(false);
              setUploadFailed(false);
              setError(null);
            }}
          >
            <option value="">
              {t("agents.control.experience.chooseSkill")}
            </option>
            {skills.map((skill) => (
              <option key={skill.skillName} value={skill.skillName}>
                {skill.skillName}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn-secondary"
          disabled={!skillName || loadingSkills || preparing || submitting}
          onClick={() => void prepare()}
        >
          {t("agents.control.experience.preparePreview")}
        </button>

        {preview ? (
          <section aria-label={t("agents.control.experience.previewTitle")}>
            <dl className="agent-control-preview-grid">
              <div>
                <dt>{t("agents.control.experience.sourceAgent")}</dt>
                <dd>{agentName}</dd>
              </div>
              <div>
                <dt>{t("agents.control.experience.sourceVersion")}</dt>
                <dd>{preview.sourceAgentVersionId}</dd>
              </div>
              <div>
                <dt>{t("agents.control.experience.fileCount")}</dt>
                <dd>{preview.fileCount}</dd>
              </div>
              <div>
                <dt>{t("agents.control.totalBytes")}</dt>
                <dd>{preview.totalBytes}</dd>
              </div>
              <div>
                <dt>{t("agents.control.experience.digest")}</dt>
                <dd>{preview.contentDigest}</dd>
              </div>
            </dl>

            <ul>
              {preview.assets.map((asset) => (
                <li key={asset.path}>{asset.path}</li>
              ))}
            </ul>

            {preview.findings.length === 0 ? (
              <p>{t("agents.control.experience.dlpPassed")}</p>
            ) : (
              <div className="agents-create-error">
                <p>{t("agents.control.experience.dlpBlocked")}</p>
                <ul>
                  {preview.findings.map((finding, index) => (
                    <li key={`${finding.code}-${finding.path}-${index}`}>
                      <span>
                        {t(`agents.control.experience.dlp.${finding.code}`)}
                      </span>{" "}
                      <span>
                        {finding.path}
                        {finding.line === null ? "" : `:${finding.line}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!online ? (
              <p className="agent-control-notice">
                {t("agents.control.experience.onlineToSubmit")}
              </p>
            ) : null}

            <label className="agent-control-confirm-row">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={preview.findings.length > 0 || submitting}
                aria-label={t("agents.control.experience.submitConfirmation")}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{t("agents.control.experience.submitConfirmation")}</span>
            </label>
          </section>
        ) : null}

        {error ? <div className="agents-create-error">{t(error)}</div> : null}
      </div>

      <footer className="agent-control-modal-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={preparing || submitting}
        >
          {t("agents.control.cancel")}
        </button>
        {preview ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {t(
              uploadFailed
                ? "agents.control.experience.retryUpload"
                : "agents.control.experience.submitForReview",
            )}
          </button>
        ) : null}
      </footer>
    </AppModal>
  );
}
