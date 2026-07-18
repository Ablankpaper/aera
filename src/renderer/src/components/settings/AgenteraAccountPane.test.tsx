import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgenteraAccountPane from "./AgenteraAccountPane";

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

describe("AgenteraAccountPane", () => {
  it("explains local-data retention and keeps recharge identity separate", async () => {
    const actions = {
      onManageAccount: vi.fn().mockResolvedValue(undefined),
      onManageDevices: vi.fn().mockResolvedValue(undefined),
      onRecharge: vi.fn().mockResolvedValue(undefined),
      onSwitchAccount: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
    };
    render(
      <AgenteraAccountPane
        state={{
          status: "authenticated",
          userId: "11111111-1111-4111-8111-111111111111",
          personalSpaceId: "22222222-2222-4222-8222-222222222222",
          deviceId: "33333333-3333-4333-8333-333333333333",
          offlineExpiresAt: "2026-07-25T01:00:00.000Z",
          cloudAvailable: true,
        }}
        {...actions}
      />,
    );

    expect(
      screen.getByText("auth.account.localDataWarning"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("auth.account.rechargeSeparateAccount"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("auth.account.pendingRevocationWarning"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.manage" }),
    );
    await waitFor(() => expect(actions.onManageAccount).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.devices" }),
    );
    await waitFor(() => expect(actions.onManageDevices).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.recharge" }),
    );
    await waitFor(() => expect(actions.onRecharge).toHaveBeenCalledOnce());
  });
});
