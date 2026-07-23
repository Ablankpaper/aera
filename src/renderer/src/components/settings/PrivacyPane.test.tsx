import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PrivacyPane from "./PrivacyPane";

const settings = vi.hoisted(() => ({
  analyticsEnabled: false,
  setAnalyticsEnabled: vi.fn(),
}));

vi.mock("./SettingsDataContext", () => ({
  useSettings: () => settings,
}));

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

vi.mock("../../utils/analytics", () => ({
  setAnalyticsConsent: vi.fn(),
}));

const authenticatedState = {
  status: "authenticated" as const,
  userId: "10000000-0000-4000-8000-000000000001",
  personalSpaceId: "20000000-0000-4000-8000-000000000001",
  deviceId: "30000000-0000-4000-8000-000000000001",
  offlineExpiresAt: "2026-07-30T00:00:00.000Z",
  cloudAvailable: true,
};

describe("PrivacyPane official quality consent", () => {
  const getConsent = vi.fn();
  const setPassiveConsent = vi.fn();
  const setExplicitFeedbackConsent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getConsent.mockResolvedValue({ passive: false, explicitFeedback: false });
    setPassiveConsent.mockResolvedValue({
      purpose: "official_quality_metrics",
      enabled: true,
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    setExplicitFeedbackConsent.mockResolvedValue({
      purpose: "official_explicit_feedback",
      enabled: true,
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    Object.defineProperty(window, "agenteraAuth", {
      configurable: true,
      value: {
        getState: vi.fn(async () => authenticatedState),
        onStateChanged: vi.fn(() => () => undefined),
      },
    });
    Object.defineProperty(window, "agenteraOfficialQuality", {
      configurable: true,
      value: {
        getConsent,
        setPassiveConsent,
        setExplicitFeedbackConsent,
        submitFeedback: vi.fn(),
        onEligible: vi.fn(() => () => undefined),
      },
    });
  });

  it("renders both official-quality choices off by default with separate disclosure copy", async () => {
    render(<PrivacyPane />);

    const passive = await screen.findByRole("checkbox", {
      name: "settings.officialQuality.passive.label",
    });
    const feedback = screen.getByRole("checkbox", {
      name: "settings.officialQuality.feedback.label",
    });
    expect(passive).not.toBeChecked();
    expect(feedback).not.toBeChecked();
    expect(
      screen.getByText("settings.officialQuality.noContent"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.officialQuality.passive.confirmation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.officialQuality.feedback.confirmation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.officialQuality.purge"),
    ).toBeInTheDocument();
  });

  it("persists the two choices independently", async () => {
    render(<PrivacyPane />);
    const passive = await screen.findByRole("checkbox", {
      name: "settings.officialQuality.passive.label",
    });
    const feedback = screen.getByRole("checkbox", {
      name: "settings.officialQuality.feedback.label",
    });

    fireEvent.click(passive);
    await waitFor(() => expect(setPassiveConsent).toHaveBeenCalledWith(true));
    expect(setExplicitFeedbackConsent).not.toHaveBeenCalled();

    fireEvent.click(feedback);
    await waitFor(() =>
      expect(setExplicitFeedbackConsent).toHaveBeenCalledWith(true),
    );
  });

  it("disables both quality choices when no authenticated or offline owner exists", async () => {
    vi.mocked(window.agenteraAuth.getState).mockResolvedValueOnce({
      status: "unauthenticated",
    });
    render(<PrivacyPane />);

    expect(
      await screen.findByRole("checkbox", {
        name: "settings.officialQuality.passive.label",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "settings.officialQuality.feedback.label",
      }),
    ).toBeDisabled();
    expect(getConsent).not.toHaveBeenCalled();
    expect(
      screen.getByText("settings.officialQuality.signInRequired"),
    ).toBeInTheDocument();
  });
});
