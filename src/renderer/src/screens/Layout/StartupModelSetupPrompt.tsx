import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  AppModal,
  AppModalDescription,
  AppModalTitle,
} from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

const SESSION_KEY_PREFIX = "agentera.model-setup-prompt.seen.v1";

function hasSeenPrompt(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function rememberPrompt(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // The prompt still remains once-per-mount if session storage is unavailable.
  }
}

function hasConfiguredModel(config: {
  provider: string;
  model: string;
}): boolean {
  return (
    config.provider.trim().toLowerCase() !== "auto" &&
    config.model.trim().length > 0
  );
}

interface StartupModelSetupPromptProps {
  ownerId: string;
  profile: string;
  onConfigure: () => void;
}

/**
 * One gentle model-setup reminder per desktop owner/Profile and app launch.
 * `sessionStorage` deliberately resets with the renderer on a fresh launch;
 * unlike localStorage, it does not suppress the reminder across restarts.
 */
export default function StartupModelSetupPrompt({
  ownerId,
  profile,
  onConfigure,
}: StartupModelSetupPromptProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sessionKey = `${SESSION_KEY_PREFIX}:${ownerId}:${profile}`;

  useEffect(() => {
    setOpen(false);
    if (hasSeenPrompt(sessionKey)) return;

    let cancelled = false;
    void window.hermesAPI
      .getModelConfig(profile)
      .then((config) => {
        if (cancelled || hasConfiguredModel(config)) return;
        // Mark it as seen before rendering. A route remount during this launch
        // must not immediately show the same reminder a second time.
        rememberPrompt(sessionKey);
        setOpen(true);
      })
      .catch(() => {
        // Unknown is not the same as unconfigured. Avoid a false-positive nag
        // when the active profile or remote connection cannot be inspected.
      });

    return () => {
      cancelled = true;
    };
  }, [profile, sessionKey]);

  const configure = (): void => {
    setOpen(false);
    onConfigure();
  };

  return (
    <AppModal
      open={open}
      onOpenChange={setOpen}
      className="startup-model-prompt"
      labelledBy="startup-model-prompt-title"
      describedBy="startup-model-prompt-description"
    >
      <div className="startup-model-prompt-copy">
        <span className="startup-model-prompt-icon" aria-hidden="true">
          <Sparkles size={19} />
        </span>
        <div>
          <AppModalTitle
            id="startup-model-prompt-title"
            className="startup-model-prompt-title"
          >
            {t("providers.setupPrompt.title")}
          </AppModalTitle>
          <AppModalDescription
            id="startup-model-prompt-description"
            className="startup-model-prompt-description"
          >
            {t("providers.setupPrompt.description")}
          </AppModalDescription>
        </div>
      </div>
      <div className="startup-model-prompt-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOpen(false)}
        >
          {t("providers.setupPrompt.later")}
        </button>
        <button type="button" className="btn btn-primary" onClick={configure}>
          {t("providers.setupPrompt.configure")}
        </button>
      </div>
    </AppModal>
  );
}
