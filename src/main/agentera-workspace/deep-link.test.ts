// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceInvitationInbox,
  findWorkspaceInvitationInArguments,
  parseWorkspaceInvitationDeepLink,
} from "./deep-link";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "Q".repeat(43);
const LINK_A = `agentera://workspace-invitation#${TOKEN_A}`;
const LINK_B = `agentera://workspace-invitation#${TOKEN_B}`;

describe("Workspace invitation deep links", () => {
  it("accepts only the exact fragment-only custom-protocol shape", () => {
    expect(parseWorkspaceInvitationDeepLink(LINK_A)).toBe(TOKEN_A);
    for (const candidate of [
      "",
      "https://workspace-invitation#" + TOKEN_A,
      "agentera://other#" + TOKEN_A,
      "AGENTERA://workspace-invitation#" + TOKEN_A,
      "agentera://user@workspace-invitation#" + TOKEN_A,
      "agentera://workspace-invitation:443#" + TOKEN_A,
      "agentera://workspace-invitation/#" + TOKEN_A,
      "agentera://workspace-invitation/path#" + TOKEN_A,
      "agentera://workspace-invitation?token=x#" + TOKEN_A,
      "agentera://workspace-invitation#",
      "agentera://workspace-invitation#" + "A".repeat(42),
      "agentera://workspace-invitation#" + "B".repeat(43),
      "agentera://workspace-invitation#%41" + TOKEN_A.slice(1),
      LINK_A + " ",
      LINK_A + "#extra",
    ]) {
      expect(parseWorkspaceInvitationDeepLink(candidate), candidate).toBeNull();
    }
  });

  it("finds the last valid invitation in initial or second-instance arguments", () => {
    expect(
      findWorkspaceInvitationInArguments([
        "/Applications/AgentEra.app",
        "--flag",
        LINK_A,
        "private-noise",
        LINK_B,
      ]),
    ).toBe(TOKEN_B);
    expect(findWorkspaceInvitationInArguments(["--flag", "noise"])).toBeNull();
  });

  it("keeps one volatile item, replaces older links, and clears only exact tokens", () => {
    const inbox = new WorkspaceInvitationInbox();
    const received = vi.fn();
    const unsubscribe = inbox.subscribe(received);

    expect(inbox.receiveDeepLink("not-a-link")).toBe(false);
    expect(inbox.peek()).toBeNull();
    expect(inbox.receiveDeepLink(LINK_A)).toBe(true);
    expect(inbox.peek()).toEqual({ token: TOKEN_A });
    expect(inbox.receiveDeepLink(LINK_B)).toBe(true);
    expect(inbox.peek()).toEqual({ token: TOKEN_B });
    expect(received).toHaveBeenNthCalledWith(1, { token: TOKEN_A });
    expect(received).toHaveBeenNthCalledWith(2, { token: TOKEN_B });

    expect(inbox.dismiss(TOKEN_A)).toBe(false);
    expect(inbox.peek()).toEqual({ token: TOKEN_B });
    expect(inbox.clearAccepted(TOKEN_A)).toBe(false);
    expect(inbox.clearAccepted(TOKEN_B)).toBe(true);
    expect(inbox.peek()).toBeNull();

    unsubscribe();
    inbox.receiveDeepLink(LINK_A);
    expect(received).toHaveBeenCalledTimes(2);
    expect(inbox.dismiss(TOKEN_A)).toBe(true);
    expect(inbox.peek()).toBeNull();
  });
});
