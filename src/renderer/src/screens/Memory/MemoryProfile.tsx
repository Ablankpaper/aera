import { useEffect, useState } from "react";
import { useI18n } from "../../components/useI18n";

interface MemoryProfileProps {
  content: string;
  charLimit: number;
  profile?: string;
  onRefresh: () => void;
}

export function MemoryProfile({
  content: initialContent,
  charLimit,
  profile,
  onRefresh,
}: MemoryProfileProps): React.JSX.Element {
  const { t } = useI18n();
  const [userContent, setUserContent] = useState(initialContent);
  const [userEditing, setUserEditing] = useState(false);
  const [userSaved, setUserSaved] = useState(false);
  const [error, setError] = useState("");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairLoading, setRepairLoading] = useState(false);
  const [repairOriginal, setRepairOriginal] = useState("");
  const [repairDraft, setRepairDraft] = useState("");
  const [repairSha256, setRepairSha256] = useState("");
  const [repairConfirmed, setRepairConfirmed] = useState(false);
  const [repairOperationId, setRepairOperationId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (userEditing) return;
    setUserContent(initialContent);
  }, [initialContent, userEditing]);

  async function handleSave(): Promise<void> {
    setError("");
    const result = await window.hermesAPI.writeUserProfile(
      userContent,
      profile,
    );
    if (result.success) {
      setUserEditing(false);
      setUserSaved(true);
      setTimeout(() => setUserSaved(false), 2000);
      onRefresh();
    } else {
      setError(result.error || t("memory.saveFailed"));
    }
  }

  async function handleOpenRepair(): Promise<void> {
    setError("");
    setRepairLoading(true);
    const result = await window.hermesAPI.previewUserMemoryRepair(profile);
    setRepairLoading(false);
    if (!result.success || !result.preview) {
      setError(result.error || t("memory.repairFailed"));
      return;
    }
    setRepairOriginal(result.preview.content);
    setRepairDraft(result.preview.content);
    setRepairSha256(result.preview.currentSha256);
    setRepairConfirmed(false);
    setRepairOperationId(null);
    setRepairOpen(true);
  }

  async function handleApplyRepair(): Promise<void> {
    setError("");
    setRepairLoading(true);
    const result = await window.hermesAPI.applyUserMemoryRepair(
      profile,
      repairSha256,
      repairDraft,
      repairConfirmed,
    );
    setRepairLoading(false);
    if (!result.success || !result.operationId) {
      setError(result.error || t("memory.repairFailed"));
      return;
    }
    setRepairOperationId(result.operationId);
    setRepairConfirmed(false);
    setUserContent(repairDraft);
    setUserEditing(false);
    onRefresh();
  }

  async function handleUndoRepair(): Promise<void> {
    if (!repairOperationId) return;
    setError("");
    setRepairLoading(true);
    const result = await window.hermesAPI.undoUserMemoryRepair(
      profile,
      repairOperationId,
    );
    setRepairLoading(false);
    if (!result.success) {
      setError(result.error || t("memory.undoRepairFailed"));
      return;
    }
    setUserContent(repairOriginal);
    setUserEditing(false);
    setRepairOpen(false);
    setRepairOperationId(null);
    onRefresh();
  }

  return (
    <div className="memory-profile">
      <div className="memory-profile-header">
        <span className="memory-profile-hint">
          {t("memory.userProfileHint")}
        </span>
        {userSaved && (
          <span
            style={{
              color: "var(--success)",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("common.saved")}
          </span>
        )}
      </div>

      {error && (
        <div className="memory-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <textarea
        className="memory-profile-textarea"
        value={userContent}
        onChange={(e) => {
          setUserContent(e.target.value);
          setUserEditing(true);
        }}
        placeholder={t("memory.userProfilePlaceholder")}
        rows={8}
      />
      <div className="memory-profile-footer">
        <span className="memory-entry-chars">
          {t("memory.chars", { count: userContent.length })} / {charLimit}{" "}
          {t("memory.chars", { count: 1 }).split(" ")[1]}
        </span>
        {userEditing && (
          <button className="btn btn-primary btn-sm" onClick={handleSave}>
            {t("memory.saveProfile")}
          </button>
        )}
      </div>

      <div className="memory-repair-entry">
        <div>
          <strong>{t("memory.repairTitle")}</strong>
          <p>{t("memory.repairHint")}</p>
        </div>
        {!repairOpen && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleOpenRepair}
            disabled={repairLoading}
          >
            {t("memory.reviewRepair")}
          </button>
        )}
      </div>

      {repairOpen && (
        <div className="memory-repair-panel">
          <div className="memory-repair-warning">
            {t("memory.repairWarning")}
          </div>
          <label className="memory-repair-label">
            {t("memory.repairOriginal")}
            <textarea
              className="memory-profile-textarea"
              value={repairOriginal}
              rows={5}
              readOnly
            />
          </label>
          <label className="memory-repair-label">
            {t("memory.repairReplacement")}
            <textarea
              className="memory-profile-textarea"
              value={repairDraft}
              onChange={(event) => setRepairDraft(event.target.value)}
              rows={5}
              disabled={Boolean(repairOperationId)}
            />
          </label>

          {repairOperationId ? (
            <div className="memory-repair-actions">
              <span className="memory-repair-success">
                {t("memory.repairApplied")}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleUndoRepair}
                disabled={repairLoading}
              >
                {t("memory.undoRepair")}
              </button>
            </div>
          ) : (
            <>
              <label className="memory-repair-confirm">
                <input
                  type="checkbox"
                  checked={repairConfirmed}
                  onChange={(event) => setRepairConfirmed(event.target.checked)}
                />
                <span>{t("memory.repairConfirm")}</span>
              </label>
              <div className="memory-repair-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRepairOpen(false)}
                  disabled={repairLoading}
                >
                  {t("memory.cancel")}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleApplyRepair}
                  disabled={
                    repairLoading ||
                    !repairConfirmed ||
                    repairDraft === repairOriginal ||
                    repairDraft.length > repairOriginal.length
                  }
                >
                  {t("memory.applyRepair")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
