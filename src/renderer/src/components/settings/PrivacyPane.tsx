import { useEffect, useState } from "react";
import { useI18n } from "../useI18n";
import { setAnalyticsConsent } from "../../utils/analytics";
import { useSettings } from "./SettingsDataContext";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type { OfficialQualityConsentSettings } from "../../../../shared/agentera-official-quality";

/** Anonymous usage analytics consent. */
export default function PrivacyPane(): React.JSX.Element {
  const { t } = useI18n();
  const { analyticsEnabled, setAnalyticsEnabled } = useSettings();
  const [ownerAvailable, setOwnerAvailable] = useState(false);
  const [qualityConsent, setQualityConsent] =
    useState<OfficialQualityConsentSettings>({
      passive: false,
      explicitFeedback: false,
    });
  const [saving, setSaving] = useState<"passive" | "feedback" | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    const applyAuthState = async (
      state: AgenteraAuthPublicState,
    ): Promise<void> => {
      const available =
        state.status === "authenticated" || state.status === "offline";
      if (!mounted) return;
      setOwnerAvailable(available);
      setSaveFailed(false);
      if (!available) {
        setQualityConsent({ passive: false, explicitFeedback: false });
        return;
      }
      try {
        const consent = await window.agenteraOfficialQuality.getConsent();
        if (mounted) setQualityConsent(consent);
      } catch {
        if (mounted) {
          setOwnerAvailable(false);
          setQualityConsent({ passive: false, explicitFeedback: false });
        }
      }
    };
    void window.agenteraAuth.getState().then(applyAuthState, () => undefined);
    const unsubscribe = window.agenteraAuth.onStateChanged((state) => {
      void applyAuthState(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const updateQualityConsent = async (
    purpose: "passive" | "feedback",
    enabled: boolean,
  ): Promise<void> => {
    if (!ownerAvailable || saving) return;
    setSaving(purpose);
    setSaveFailed(false);
    try {
      const receipt =
        purpose === "passive"
          ? await window.agenteraOfficialQuality.setPassiveConsent(enabled)
          : await window.agenteraOfficialQuality.setExplicitFeedbackConsent(
              enabled,
            );
      setQualityConsent((current) => ({
        ...current,
        [purpose === "passive" ? "passive" : "explicitFeedback"]:
          receipt.enabled,
      }));
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="settings-modal-pane">
      <div className="settings-field">
        <label className="settings-field-label">
          {t("settings.analytics.label")}
          <label
            className="tools-toggle"
            style={{ marginLeft: 12, verticalAlign: "middle" }}
          >
            <input
              type="checkbox"
              checked={analyticsEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setAnalyticsEnabled(enabled);
                setAnalyticsConsent(enabled);
              }}
            />
            <span className="tools-toggle-track" />
          </label>
        </label>
        <div className="settings-field-hint">
          {t("settings.analytics.hint")}
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field-label">
          {t("settings.officialQuality.title")}
        </div>
        <div className="settings-field-hint">
          {t("settings.officialQuality.noContent")}
        </div>
        <div className="settings-field-hint">
          {t("settings.officialQuality.purge")}
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-field-label">
          {t("settings.officialQuality.passive.label")}
          <span
            className="tools-toggle"
            style={{ marginLeft: 12, verticalAlign: "middle" }}
          >
            <input
              type="checkbox"
              checked={qualityConsent.passive}
              disabled={!ownerAvailable || saving !== null}
              onChange={(event) => {
                void updateQualityConsent("passive", event.target.checked);
              }}
            />
            <span className="tools-toggle-track" />
          </span>
        </label>
        <div className="settings-field-hint">
          {t("settings.officialQuality.passive.confirmation")}
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-field-label">
          {t("settings.officialQuality.feedback.label")}
          <span
            className="tools-toggle"
            style={{ marginLeft: 12, verticalAlign: "middle" }}
          >
            <input
              type="checkbox"
              checked={qualityConsent.explicitFeedback}
              disabled={!ownerAvailable || saving !== null}
              onChange={(event) => {
                void updateQualityConsent("feedback", event.target.checked);
              }}
            />
            <span className="tools-toggle-track" />
          </span>
        </label>
        <div className="settings-field-hint">
          {t("settings.officialQuality.feedback.confirmation")}
        </div>
      </div>

      {!ownerAvailable && (
        <div className="settings-field-hint">
          {t("settings.officialQuality.signInRequired")}
        </div>
      )}
      {saveFailed && (
        <div className="settings-field-hint" role="alert">
          {t("settings.officialQuality.saveFailed")}
        </div>
      )}
    </div>
  );
}
