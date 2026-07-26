import { useCallback, useEffect, useState } from "react";
import { Plus, Refresh, Trash } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import {
  AGENTERA_GLOBAL_PROFILE_CATEGORIES,
  type AgenteraGlobalProfile,
  type AgenteraGlobalProfileCategory,
  type AgenteraGlobalProfileHistoryItem,
} from "../../../../shared/agentera-global-profile";

export function GlobalBehaviorProfile(): React.JSX.Element {
  const { t } = useI18n();
  const [profile, setProfile] = useState<AgenteraGlobalProfile | null>(null);
  const [history, setHistory] = useState<AgenteraGlobalProfileHistoryItem[]>(
    [],
  );
  const [category, setCategory] = useState<AgenteraGlobalProfileCategory>(
    "communication_style",
  );
  const [entryKey, setEntryKey] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [current, versions] = await Promise.all([
      window.agenteraGlobalProfile.get(),
      window.agenteraGlobalProfile.listHistory(),
    ]);
    if (!current.success) {
      setError(current.error);
      return;
    }
    setProfile(current.value);
    setHistory(versions.success ? versions.value : []);
    setError(versions.success ? "" : versions.error);
  }, []);

  useEffect(() => {
    void load();
    return window.agenteraGlobalProfile.onChanged((nextProfile) => {
      setProfile(nextProfile);
      void window.agenteraGlobalProfile.listHistory().then((result) => {
        if (result.success) setHistory(result.value);
      });
    });
  }, [load]);

  async function handleSave(): Promise<void> {
    const suffix = entryKey.trim().toLowerCase();
    if (!suffix || !content.trim()) return;
    setSaving(true);
    setError("");
    const result = await window.agenteraGlobalProfile.setEntry({
      id: `${category}.${suffix}`,
      category,
      content,
    });
    setSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setProfile(result.value);
    setEntryKey("");
    setContent("");
    await load();
  }

  async function handleRemove(entryId: string): Promise<void> {
    setError("");
    const result = await window.agenteraGlobalProfile.removeEntry(entryId);
    setConfirmRemove(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setProfile(result.value);
    await load();
  }

  async function handleRollback(version: number): Promise<void> {
    setError("");
    const result = await window.agenteraGlobalProfile.rollback(version);
    setConfirmRollback(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setProfile(result.value);
    await load();
  }

  if (!profile) {
    return (
      <div className="memory-empty">
        {error ? <p>{error}</p> : <div className="loading-spinner" />}
      </div>
    );
  }

  return (
    <div className="global-profile-pane">
      <div className="global-profile-banner">
        <div>
          <strong>{t("memory.globalProfileTitle")}</strong>
          <p>{t("memory.globalProfileHint")}</p>
        </div>
        <span className="global-profile-version">
          v{profile.profileVersion}
        </span>
      </div>

      {error && <div className="memory-error">{error}</div>}

      <div className="global-profile-form">
        <select
          className="settings-select"
          value={category}
          aria-label={t("memory.globalProfileCategory")}
          onChange={(event) =>
            setCategory(event.target.value as AgenteraGlobalProfileCategory)
          }
        >
          {AGENTERA_GLOBAL_PROFILE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {t(`memory.globalCategories.${value}`)}
            </option>
          ))}
        </select>
        <div className="global-profile-key-field">
          <span>{category}.</span>
          <input
            className="settings-input"
            value={entryKey}
            aria-label={t("memory.globalProfileKey")}
            placeholder={t("memory.globalProfileKeyPlaceholder")}
            onChange={(event) => setEntryKey(event.target.value)}
          />
        </div>
        <textarea
          className="memory-profile-textarea"
          value={content}
          aria-label={t("memory.globalProfileContent")}
          placeholder={t("memory.globalProfileContentPlaceholder")}
          rows={3}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="global-profile-form-actions">
          <span>{t("memory.globalProfileExplicitOnly")}</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={saving || !entryKey.trim() || !content.trim()}
          >
            <Plus size={13} />
            {t("memory.globalProfileAdd")}
          </button>
        </div>
      </div>

      <div className="global-profile-list">
        {profile.entries.length === 0 ? (
          <div className="memory-empty">
            <p>{t("memory.globalProfileEmpty")}</p>
          </div>
        ) : (
          profile.entries.map((entry) => (
            <article className="global-profile-entry" key={entry.id}>
              <div>
                <code>{entry.id}</code>
                <p>{entry.content}</p>
              </div>
              {confirmRemove === entry.id ? (
                <div className="memory-entry-confirm">
                  <button
                    className="btn btn-danger-ghost btn-sm"
                    onClick={() => handleRemove(entry.id)}
                  >
                    {t("memory.yes")}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmRemove(null)}
                  >
                    {t("memory.no")}
                  </button>
                </div>
              ) : (
                <button
                  className="btn-ghost memory-entry-btn"
                  aria-label={`${t("memory.removeGlobalProfileEntry")} ${entry.id}`}
                  onClick={() => setConfirmRemove(entry.id)}
                >
                  <Trash size={13} />
                </button>
              )}
            </article>
          ))
        )}
      </div>

      {history.length > 0 && (
        <section className="global-profile-history">
          <div className="global-profile-history-header">
            <strong>{t("memory.globalProfileHistory")}</strong>
            <button className="btn-ghost" onClick={load}>
              <Refresh size={13} />
            </button>
          </div>
          {history.slice(0, 8).map((item) => (
            <div
              className="global-profile-history-row"
              key={item.profileVersion}
            >
              <span>
                v{item.profileVersion} · {item.entryCount}{" "}
                {t("memory.memories")}
              </span>
              {confirmRollback === item.profileVersion ? (
                <span className="memory-entry-confirm">
                  <button
                    className="btn btn-danger-ghost btn-sm"
                    onClick={() => handleRollback(item.profileVersion)}
                  >
                    {t("memory.yes")}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmRollback(null)}
                  >
                    {t("memory.no")}
                  </button>
                </span>
              ) : (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setConfirmRollback(item.profileVersion)}
                >
                  {t("memory.globalProfileRollback")}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
