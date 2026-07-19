import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Install from "./Install";

const i18n = vi.hoisted(() => ({
  t: (key: string): string => key,
}));

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: i18n.t,
  }),
}));

describe("automatic packaged Runtime preparation", () => {
  const startInstall = vi.fn();
  const onInstallProgress = vi.fn(() => vi.fn());

  beforeEach(() => {
    startInstall.mockReset();
    onInstallProgress.mockClear();
    i18n.t = (key: string): string => key;
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        startInstall,
        onInstallProgress,
      },
    });
  });

  // @lat: [[agentera-runtime-distribution#Offline first installation]]
  it("starts the bundled Runtime automatically and continues when ready", async () => {
    startInstall.mockResolvedValue({ success: true });
    const onComplete = vi.fn();

    render(<Install onComplete={onComplete} />);

    await waitFor(() => expect(startInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers a manual Runtime source on the normal first-install path", async () => {
    startInstall.mockImplementation(() => new Promise(() => undefined));

    render(<Install onComplete={vi.fn()} />);

    await waitFor(() => expect(startInstall).toHaveBeenCalledOnce());
    expect(screen.queryByText("install.confirmPrepareBtn")).toBeNull();
    expect(screen.queryByText("install.useExistingBtn")).toBeNull();
    expect(screen.queryByText("install.continueToSetup")).toBeNull();
  });

  it("retries a recoverable local preparation failure", async () => {
    startInstall
      .mockResolvedValueOnce({
        success: false,
        action: "retry",
        error: "synthetic failure",
      })
      .mockImplementationOnce(() => new Promise(() => undefined));

    render(<Install onComplete={vi.fn()} />);

    const retry = await screen.findByRole("button", {
      name: "install.retryPreparation",
    });
    fireEvent.click(retry);
    await waitFor(() => expect(startInstall).toHaveBeenCalledTimes(2));
  });

  it("shows reinstall guidance without retrying an invalid packaged Seed", async () => {
    startInstall.mockResolvedValue({
      success: false,
      action: "reinstall-desktop",
    });

    render(<Install onComplete={vi.fn()} />);

    expect(
      await screen.findByText("install.packagedRuntimeInvalid"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "install.retryPreparation" }),
    ).toBeNull();
    expect(startInstall).toHaveBeenCalledOnce();
  });

  it("uses a safe fallback when installation rejects without an Error", async () => {
    startInstall.mockRejectedValue(null);

    render(<Install onComplete={vi.fn()} />);

    expect(
      await screen.findByText("install.preparationFailedHint"),
    ).toBeInTheDocument();
  });

  it("does not restart preparation when the translation function changes", async () => {
    startInstall.mockImplementation(() => new Promise(() => undefined));
    const view = render(<Install onComplete={vi.fn()} />);
    await waitFor(() => expect(startInstall).toHaveBeenCalledOnce());

    i18n.t = (key: string): string => `updated:${key}`;
    view.rerender(<Install onComplete={vi.fn()} />);

    expect(startInstall).toHaveBeenCalledOnce();
  });
});
