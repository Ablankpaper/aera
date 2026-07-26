import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage, {
  SETTINGS_FEATURE_SECTIONS,
  SETTINGS_NAV,
  resolveSection,
} from "./SettingsModal";

vi.mock("../useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("./useSettingsData", () => ({
  useSettingsData: () => ({}),
}));
vi.mock("./AgenteraAccountPane", () => ({
  default: () => <div>account-pane</div>,
}));
vi.mock("./AppearancePane", () => ({
  default: () => <div>appearance-pane</div>,
}));
vi.mock("./LanguagePane", () => ({ default: () => <div>language-pane</div> }));
vi.mock("./PrivacyPane", () => ({ default: () => <div>privacy-pane</div> }));
vi.mock("./ConnectionPane", () => ({
  default: () => <div>connection-pane</div>,
}));
vi.mock("./DataPane", () => ({ default: () => <div>data-pane</div> }));
vi.mock("./AboutPane", () => ({ default: () => <div>about-pane</div> }));
vi.mock("./LogsPane", () => ({ default: () => <div>logs-pane</div> }));
vi.mock("../../screens/Providers/Providers", () => ({
  default: () => <div>providers-pane</div>,
}));
vi.mock("../../screens/Gateway/Gateway", () => ({
  default: () => <div>gateway-pane</div>,
}));
vi.mock("../../screens/Tools/Tools", () => ({
  default: () => <div>tools-pane</div>,
}));
vi.mock("../../screens/Memory/Memory", () => ({
  default: () => <div>memory-pane</div>,
}));
vi.mock("../RemoteNotice", () => ({
  default: () => <div>remote-notice</div>,
}));

import { SettingsModalProvider } from "./SettingsModalProvider";
import { useSettingsModal } from "./SettingsModalContext";

function SettingsLauncher(): React.JSX.Element {
  const { openSettings } = useSettingsModal();
  return (
    <button type="button" onClick={() => openSettings("appearance")}>
      open-settings
    </button>
  );
}

describe("Settings feature navigation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { process: { platform: "darwin", versions: {} } },
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        isRemoteOnlyMode: vi.fn().mockResolvedValue(false),
      },
    });
  });

  it("owns the provider, gateway, tools, and memory destinations", () => {
    expect(SETTINGS_FEATURE_SECTIONS).toEqual([
      "providers",
      "gateway",
      "tools",
      "memory",
    ]);
    expect(
      SETTINGS_NAV.filter((item) =>
        SETTINGS_FEATURE_SECTIONS.includes(
          item.id as (typeof SETTINGS_FEATURE_SECTIONS)[number],
        ),
      ).map((item) => ({ id: item.id, group: item.group })),
    ).toEqual([
      { id: "providers", group: "hermes" },
      { id: "gateway", group: "hermes" },
      { id: "tools", group: "hermes" },
      { id: "memory", group: "hermes" },
    ]);
  });

  it.each(SETTINGS_FEATURE_SECTIONS)(
    "resolves the %s navigation target directly",
    (section) => {
      expect(resolveSection(section)).toBe(section);
    },
  );

  it("keeps legacy settings aliases and the account fallback", () => {
    expect(resolveSection("hermesagent")).toBe("about");
    expect(resolveSection("network")).toBe("connection");
    expect(resolveSection("unknown")).toBe("account");
  });

  it("renders settings as a full page with a back action and no close button", () => {
    const onBack = vi.fn();
    const { container } = render(<SettingsPage onBack={onBack} />);

    expect(container.querySelector(".settings-page")).toBeInTheDocument();
    expect(
      container.querySelector(".app-modal-overlay"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "settings.title" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "common.cancel" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("hides the main surface while settings is open and restores it on return", () => {
    const { container } = render(
      <SettingsModalProvider>
        <div data-testid="main-surface">main</div>
        <SettingsLauncher />
      </SettingsModalProvider>,
    );

    const background = container.querySelector(".settings-page-background");
    expect(background).not.toHaveClass("is-hidden");

    fireEvent.click(screen.getByRole("button", { name: "open-settings" }));
    expect(background).toHaveClass("is-hidden");
    expect(screen.getByText("appearance-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(container.querySelector(".settings-page")).not.toBeInTheDocument();
    expect(background).not.toHaveClass("is-hidden");
    expect(screen.getByTestId("main-surface")).toBeInTheDocument();
  });
});
