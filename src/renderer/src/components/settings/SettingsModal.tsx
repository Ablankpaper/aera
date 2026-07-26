import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Brain,
  Cpu,
  Database,
  FileText,
  Info,
  Languages,
  Palette,
  Plug,
  Signal,
  ShieldCheck,
  UserRound,
  Workflow,
} from "lucide-react";
import { useI18n } from "../useI18n";
import RemoteNotice from "../RemoteNotice";
import Gateway from "../../screens/Gateway/Gateway";
import Memory from "../../screens/Memory/Memory";
import Providers from "../../screens/Providers/Providers";
import Tools from "../../screens/Tools/Tools";
import { useSettingsData } from "./useSettingsData";
import { SettingsDataContext } from "./SettingsDataContext";
import AppearancePane from "./AppearancePane";
import LanguagePane from "./LanguagePane";
import PrivacyPane from "./PrivacyPane";
import ConnectionPane from "./ConnectionPane";
import DataPane from "./DataPane";
import AboutPane from "./AboutPane";
import LogsPane from "./LogsPane";
import AgenteraAccountPane from "./AgenteraAccountPane";

export type SettingsSection =
  | "account"
  | "appearance"
  | "language"
  | "privacy"
  | "connection"
  | "data"
  | "providers"
  | "gateway"
  | "tools"
  | "memory"
  | "about"
  | "logs";

type NavGroup = "general" | "hermes";

/** Left-nav sections, grouped. Each renders into the right-hand content pane. */
export const SETTINGS_NAV: ReadonlyArray<{
  group: NavGroup;
  id: SettingsSection;
  labelKey: string;
  Icon: React.ComponentType<{ size?: number }>;
}> = [
  {
    group: "general",
    id: "account",
    labelKey: "auth.account.settingsNav",
    Icon: UserRound,
  },
  {
    group: "general",
    id: "appearance",
    labelKey: "settings.nav.appearance",
    Icon: Palette,
  },
  {
    group: "general",
    id: "language",
    labelKey: "settings.nav.language",
    Icon: Languages,
  },
  {
    group: "general",
    id: "privacy",
    labelKey: "settings.nav.privacy",
    Icon: ShieldCheck,
  },
  {
    group: "general",
    id: "connection",
    labelKey: "settings.nav.connection",
    Icon: Plug,
  },
  {
    group: "general",
    id: "data",
    labelKey: "settings.nav.data",
    Icon: Database,
  },
  {
    group: "hermes",
    id: "providers",
    labelKey: "navigation.providers",
    Icon: Cpu,
  },
  {
    group: "hermes",
    id: "gateway",
    labelKey: "navigation.gateway",
    Icon: Signal,
  },
  {
    group: "hermes",
    id: "tools",
    labelKey: "navigation.tools",
    Icon: Workflow,
  },
  {
    group: "hermes",
    id: "memory",
    labelKey: "navigation.memory",
    Icon: Brain,
  },
  { group: "hermes", id: "about", labelKey: "settings.nav.about", Icon: Info },
  {
    group: "hermes",
    id: "logs",
    labelKey: "settings.nav.logs",
    Icon: FileText,
  },
];

const NAV_GROUP_ORDER: { id: NavGroup; labelKey: string }[] = [
  { id: "general", labelKey: "settings.nav.groups.general" },
  { id: "hermes", labelKey: "settings.nav.groups.hermes" },
];

/** Map a `/settings <name>` argument (and legacy anchor names) to a nav id. */
export function resolveSection(name?: string): SettingsSection {
  const key = (name || "").trim().toLowerCase();
  if (key === "hermesagent") return "about";
  // Network merged into Connection — keep the old `/settings network` working.
  if (key === "network") return "connection";
  const match = SETTINGS_NAV.find((s) => s.id === key);
  return match ? match.id : "account";
}

export const SETTINGS_FEATURE_SECTIONS = [
  "providers",
  "gateway",
  "tools",
  "memory",
] as const satisfies ReadonlyArray<SettingsSection>;

type SettingsFeatureSection = (typeof SETTINGS_FEATURE_SECTIONS)[number];

function isFeatureSection(
  section: SettingsSection,
): section is SettingsFeatureSection {
  return SETTINGS_FEATURE_SECTIONS.some((item) => item === section);
}

interface SettingsPageProps {
  profile?: string;
  initialSection?: string;
  onBack: () => void;
}

/**
 * Global full-page settings surface: a grouped left nav + a single active
 * pane on the right. Opened from anywhere via `SettingsModalProvider`'s
 * `openSettings`, then returned from with the page-level back action.
 */
export default function SettingsPage({
  profile,
  initialSection,
  onBack,
}: SettingsPageProps): React.JSX.Element {
  const { t } = useI18n();
  const data = useSettingsData(profile);
  const [section, setSection] = useState<SettingsSection>(() =>
    resolveSection(initialSection),
  );
  const [visitedSections, setVisitedSections] = useState<Set<SettingsSection>>(
    () => new Set([resolveSection(initialSection)]),
  );
  const [remoteMode, setRemoteMode] = useState(false);

  // Re-seed the active pane whenever an already-open page is targeted at a
  // different section via the slash command.
  useEffect(() => {
    const nextSection = resolveSection(initialSection);
    setSection(nextSection);
    setVisitedSections((previous) =>
      previous.has(nextSection) ? previous : new Set(previous).add(nextSection),
    );
  }, [initialSection]);

  useEffect(() => {
    let cancelled = false;
    void window.hermesAPI
      .isRemoteOnlyMode()
      .then((value) => {
        if (!cancelled) setRemoteMode(value);
      })
      .catch(() => {
        if (!cancelled) setRemoteMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack]);

  const selectSection = (nextSection: SettingsSection): void => {
    setSection(nextSection);
    setVisitedSections((previous) =>
      previous.has(nextSection) ? previous : new Set(previous).add(nextSection),
    );
  };

  const browseDiscover = (kind: "skills" | "mcps"): void => {
    onBack();
    window.dispatchEvent(
      new CustomEvent("navigation:focus-discover", { detail: kind }),
    );
  };

  const isMac = window.electron?.process?.platform === "darwin";

  return (
    <section
      className={`settings-page${isMac ? " is-mac" : ""}`}
      aria-labelledby="settings-page-title"
    >
      <header className="settings-page-header">
        <button
          type="button"
          className="settings-page-back"
          onClick={onBack}
          aria-label={t("common.back")}
          autoFocus
        >
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{t("common.back")}</span>
        </button>
        <h1 id="settings-page-title" className="settings-page-title">
          {t("settings.title")}
        </h1>
      </header>

      <div className="settings-page-layout">
        <nav className="settings-page-nav" aria-label={t("settings.title")}>
          {NAV_GROUP_ORDER.map((g) => (
            <div key={g.id} className="settings-page-nav-group">
              <div className="settings-page-nav-group-label">
                {t(g.labelKey)}
              </div>
              {SETTINGS_NAV.filter((s) => s.group === g.id).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`settings-page-nav-item ${
                    section === s.id ? "active" : ""
                  }`}
                  onClick={() => selectSection(s.id)}
                >
                  <s.Icon size={16} />
                  {t(s.labelKey)}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div
          className={`settings-page-content ${
            isFeatureSection(section) ? "settings-page-content-feature" : ""
          }`}
        >
          <SettingsDataContext.Provider value={data}>
            {section === "account" && <AgenteraAccountPane />}
            {section === "appearance" && <AppearancePane />}
            {section === "language" && <LanguagePane />}
            {section === "privacy" && <PrivacyPane />}
            {section === "connection" && <ConnectionPane />}
            {section === "data" && <DataPane />}
            {section === "about" && <AboutPane />}
            {section === "logs" && <LogsPane />}
            {visitedSections.has("providers") && (
              <div
                className="settings-page-feature-pane"
                hidden={section !== "providers"}
              >
                {remoteMode ? (
                  <RemoteNotice feature={t("navigation.providers")} />
                ) : (
                  <Providers
                    profile={profile}
                    visible={section === "providers"}
                  />
                )}
              </div>
            )}
            {visitedSections.has("gateway") && (
              <div
                className="settings-page-feature-pane"
                hidden={section !== "gateway"}
              >
                {remoteMode ? (
                  <RemoteNotice feature={t("navigation.gateway")} />
                ) : (
                  <Gateway profile={profile} />
                )}
              </div>
            )}
            {visitedSections.has("tools") && (
              <div
                className="settings-page-feature-pane"
                hidden={section !== "tools"}
              >
                <Tools
                  profile={profile}
                  showPlatformToolsets={!remoteMode}
                  remoteMode={remoteMode}
                  visible={section === "tools"}
                  onBrowseSkills={() => browseDiscover("skills")}
                  onBrowseMcps={() => browseDiscover("mcps")}
                />
              </div>
            )}
            {visitedSections.has("memory") && (
              <div
                className="settings-page-feature-pane"
                hidden={section !== "memory"}
              >
                {remoteMode ? (
                  <RemoteNotice feature={t("navigation.memory")} />
                ) : (
                  <Memory profile={profile} />
                )}
              </div>
            )}
          </SettingsDataContext.Provider>
        </div>
      </div>
    </section>
  );
}
