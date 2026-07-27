import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import AuthGate from "./AuthGate";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

const unauthenticated: AgenteraAuthPublicState = {
  status: "unauthenticated",
  reason: "sign_in_required",
};

describe("AuthGate", () => {
  it("presents Aila in 3D and offers one browser sign-in action without collecting credentials", () => {
    render(
      <AuthGate
        state={unauthenticated}
        onOpenBrowser={vi.fn().mockResolvedValue(undefined)}
        onCopyLoginLink={vi.fn().mockResolvedValue(undefined)}
        onRestartLogin={vi.fn().mockResolvedValue(undefined)}
        onRetry={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("auth.gate.slogan")).toBeInTheDocument();
    expect(screen.getByTestId("aila-3d-model")).toBeInTheDocument();
    expect(screen.getByText("auth.gate.privacy")).toBeInTheDocument();
    expect(screen.getByText("auth.gate.terms")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    ).toHaveFocus();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText(/password|phone|email|code/i)).toBeNull();
    expect(document.querySelector("webview")).toBeNull();
  });

  it("shows the browser waiting surface and keeps a restart isolated from the cancelled attempt", async () => {
    let rejectLogin: ((error: Error) => void) | undefined;
    let finishRestart: (() => void) | undefined;
    const onOpenBrowser = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLogin = reject;
        }),
    );
    const onCopyLoginLink = vi.fn().mockResolvedValue(undefined);
    const onRestartLogin = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRestart = resolve;
        }),
    );

    render(
      <AuthGate
        state={unauthenticated}
        onOpenBrowser={onOpenBrowser}
        onCopyLoginLink={onCopyLoginLink}
        onRestartLogin={onRestartLogin}
        onRetry={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    );
    expect(onOpenBrowser).toHaveBeenCalledOnce();

    expect(
      await screen.findByTestId("browser-login-waiting"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "auth.gate.loggingIn" }),
    ).toBeDisabled();
    expect(screen.getByText("auth.gate.browserNotOpened")).toBeInTheDocument();
    expect(screen.getByText("auth.gate.copyLoginHint")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "auth.gate.restartLogin" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "auth.gate.cancel" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.copyLoginLink" }),
    );
    await waitFor(() => expect(onCopyLoginLink).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("button", {
        name: "auth.gate.copiedLoginLink",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.restartLogin" }),
    );
    expect(onRestartLogin).toHaveBeenCalledOnce();

    await act(async () => {
      rejectLogin?.(new Error("cancelled"));
    });
    expect(screen.getByTestId("browser-login-waiting")).toBeInTheDocument();
    expect(screen.queryByText("auth.gate.loginFailed")).toBeNull();

    await act(async () => finishRestart?.());
  });

  it("explains secure-storage failure and supports an explicit retry", () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthGate
        state={{
          status: "blocked",
          reason: "secure_storage_unavailable",
        }}
        onOpenBrowser={vi.fn().mockResolvedValue(undefined)}
        onCopyLoginLink={vi.fn().mockResolvedValue(undefined)}
        onRestartLogin={vi.fn().mockResolvedValue(undefined)}
        onRetry={onRetry}
      />,
    );

    expect(
      screen.getByText("auth.gate.secureStorageTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("auth.gate.secureStorageDescription"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "auth.gate.retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
