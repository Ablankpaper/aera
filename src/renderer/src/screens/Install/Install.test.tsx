import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Install from "./Install";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

describe("automatic packaged Runtime preparation", () => {
  const startInstall = vi.fn();
  const onInstallProgress = vi.fn(() => vi.fn());

  beforeEach(() => {
    startInstall.mockReset();
    onInstallProgress.mockClear();
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
});
