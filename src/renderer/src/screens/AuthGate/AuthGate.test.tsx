import { fireEvent, render, screen } from "@testing-library/react";
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
  it("offers one browser authorization action without collecting credentials", () => {
    render(
      <AuthGate
        state={unauthenticated}
        onOpenBrowser={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn().mockResolvedValue(undefined)}
        onRetry={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("AgentEra")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    ).toHaveFocus();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText(/password|phone|email|code/i)).toBeNull();
    expect(document.querySelector("webview")).toBeNull();
  });

  it("keeps the gate visible while browser authorization can be cancelled", async () => {
    let finishLogin: (() => void) | undefined;
    const onOpenBrowser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogin = resolve;
        }),
    );
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthGate
        state={unauthenticated}
        onOpenBrowser={onOpenBrowser}
        onCancel={onCancel}
        onRetry={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    );
    expect(onOpenBrowser).toHaveBeenCalledOnce();

    const cancel = await screen.findByRole("button", {
      name: "auth.gate.cancel",
    });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();

    finishLogin?.();
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
        onCancel={vi.fn().mockResolvedValue(undefined)}
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
