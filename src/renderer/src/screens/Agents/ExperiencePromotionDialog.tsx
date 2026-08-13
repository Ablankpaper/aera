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

  const share = async (): Promise<void> => {
    if (!skillName || preparing || submitting) return;
    setPreparing(true);
    setPreview(null);
    setError(null);
    setUploadFailed(false);
    try {
      const prepared = await window.agenteraAgents.prepareExperienceCandidate({
        installationId: installation.id,
        skillName,
      });
      if (!prepared.ok) {
        setError(errorKey(prepared.errorCode));
        return;
      }
      setPreview(prepared.data);
      if (!online || prepared.data.findings.length > 0) return;
      setPreparing(false);
      setSubmitting(true);
      const submitted = await window.agenteraAgents.submitExperienceCandidate({
        candidateId: prepared.data.localCandidateId,
        confirmation: "submit-selected-skill",
      });
      if (!submitted.ok) {
        setError(errorKey(submitted.errorCode));
        setUploadFailed(true);
        return;
      }
      setPreview(null);
      onSubmitted(submitted.data);
    } catch {
      setError("agents.control.errors.operation_failed");
      setUploadFailed(true);
    } finally {
      setPreparing(false);
      setSubmitting(false);
    }
  };

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
          className="btn btn-primary"
          disabled={!skillName || loadingSkills || preparing || submitting}
          onClick={() => void share()}
        >
          {t(
            preparing || submitting
              ? "agents.control.experience.shareInProgress"
              : uploadFailed
                ? "agents.control.experience.retryShare"
                : "agents.control.experience.share",
          )}
        </button>

        {preview ? (
          <section aria-label={t("agents.control.experience.shareStatus")}>
            {preview.findings.length > 0 ? (
              <div className="agents-create-error">
                <p>{t("agents.control.experience.dlpBlockedUser")}</p>
                <p>{t("agents.control.experience.dlpChooseAnother")}</p>
              </div>
            ) : !online ? (
              <p className="agent-control-notice">
                {t("agents.control.experience.onlineToShare")}
              </p>
            ) : null}
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
      </footer>
    </AppModal>
  );
}
