import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const profile = {
    userId: offlineState.userId,
    displayName: "Alice",
    occupation: "Product designer",
    bio: "Building useful agents.",
    avatarDataUrl: "data:image/png;base64,YXZhdGFy",
    updatedAt: "2026-07-25T02:00:00.000Z",
  };

  beforeEach(() => {
    Object.defineProperty(window, "agenteraAuth", {
      configurable: true,
      value: {
        getUserProfile: vi.fn().mockResolvedValue(profile),
        updateUserProfile: vi.fn(),
        onUserProfileChanged: vi.fn(() => vi.fn()),
      },
    });
  });

  // @lat: [[agentera-app-authentication#Startup gate#Account-required routing]]
  it("shows a bottom-left sign-in control and opens browser login only after activation", async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    render(
      <AgenteraAccountMenu
        state={{ status: "unauthenticated", reason: "sign_in_required" }}
        onSignIn={onSignIn}
      />,
    );

    expect(onSignIn).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "auth.account.signIn" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.signIn" }),
    );
    await waitFor(() => expect(onSignIn).toHaveBeenCalledOnce());
  });

  it("shows account actions with Settings between switch account and sign out", async () => {
    const actions = {
      onManageAccount: vi.fn().mockResolvedValue(undefined),
      onManageDevices: vi.fn().mockResolvedValue(undefined),
      onRecharge: vi.fn().mockResolvedValue(undefined),
      onSwitchAccount: vi.fn().mockResolvedValue(undefined),
      onOpenSettings: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
    };
    render(<AgenteraAccountMenu state={offlineState} {...actions} />);

    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.openMenu" }),
    );
    expect(screen.getAllByText("auth.account.offline")).toHaveLength(2);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "auth.account.manage",
      "auth.account.devices",
      "auth.account.recharge",
      "auth.account.switch",
      "navigation.settings",
      "auth.account.signOut",
    ]);
    for (const [name, action] of [
      ["auth.account.manage", actions.onManageAccount],
      ["auth.account.devices", actions.onManageDevices],
      ["auth.account.recharge", actions.onRecharge],
      ["auth.account.switch", actions.onSwitchAccount],
      ["navigation.settings", actions.onOpenSettings],
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

  it("shows the signed-in user's name and avatar in the bottom-left account control", async () => {
    render(<AgenteraAccountMenu state={offlineState} />);

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Alice" })).toHaveAttribute(
      "src",
      profile.avatarDataUrl,
    );
    expect(screen.queryByText("auth.account.title")).not.toBeInTheDocument();
  });
});
