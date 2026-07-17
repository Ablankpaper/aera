import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgenteraAccountMenu from "./AgenteraAccountMenu";
import AgenteraOfflineBanner from "./AgenteraOfflineBanner";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

const offlineState = {
  status: "offline" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  personalSpaceId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  offlineExpiresAt: "2026-07-25T01:00:00.000Z",
  cloudAvailable: false,
};

describe("AgenteraAccountMenu", () => {
  it("shows offline status and exposes account, device, recharge, switch, and logout controls", async () => {
    const actions = {
      onManageAccount: vi.fn().mockResolvedValue(undefined),
      onManageDevices: vi.fn().mockResolvedValue(undefined),
      onRecharge: vi.fn().mockResolvedValue(undefined),
      onSwitchAccount: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
    };
    render(<AgenteraAccountMenu state={offlineState} {...actions} />);

    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.openMenu" }),
    );
    expect(screen.getAllByText("auth.account.offline")).toHaveLength(2);
    for (const [name, action] of [
      ["auth.account.manage", actions.onManageAccount],
      ["auth.account.devices", actions.onManageDevices],
      ["auth.account.recharge", actions.onRecharge],
      ["auth.account.switch", actions.onSwitchAccount],
      ["auth.account.signOut", actions.onSignOut],
    ] as const) {
      fireEvent.click(screen.getByRole("menuitem", { name }));
      await waitFor(() => expect(action).toHaveBeenCalledOnce());
      if (name !== "auth.account.signOut") {
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "auth.account.openMenu" }),
          ).not.toBeDisabled(),
        );
        fireEvent.click(
          screen.getByRole("button", { name: "auth.account.openMenu" }),
        );
      }
    }
  });

  it("renders a clear local-only banner without claiming model APIs are unavailable", () => {
    render(<AgenteraOfflineBanner state={offlineState} />);
    expect(screen.getByText("auth.offline.title")).toBeInTheDocument();
    expect(screen.getByText("auth.offline.description")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/model.*unavailable/i);
  });
});
