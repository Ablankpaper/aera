// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceInvitationInbox } from "../agentera-workspace/deep-link";
import {
  findOrganizationInvitationInArguments,
  parseOrganizationInvitationDeepLink,
} from "./deep-link";

const ORGANIZATION_TOKEN_A = "A".repeat(43);
const ORGANIZATION_TOKEN_B = "Q".repeat(43);
const WORKSPACE_TOKEN = "g".repeat(43);
const ORGANIZATION_LINK_A = `agentera://organization-invitation#${ORGANIZATION_TOKEN_A}`;
const ORGANIZATION_LINK_B = `agentera://organization-invitation#${ORGANIZATION_TOKEN_B}`;
const WORKSPACE_LINK = `agentera://workspace-invitation#${WORKSPACE_TOKEN}`;

describe("Organization invitation deep links", () => {
  it("accepts only the exact fragment-only Organization shape", () => {
    expect(parseOrganizationInvitationDeepLink(ORGANIZATION_LINK_A)).toBe(
      ORGANIZATION_TOKEN_A,
    );
    for (const candidate of [
      "",
      `https://organization-invitation#${ORGANIZATION_TOKEN_A}`,
      `agentera://workspace-invitation#${ORGANIZATION_TOKEN_A}`,
      `agentera://other#${ORGANIZATION_TOKEN_A}`,
      `AGENTERA://organization-invitation#${ORGANIZATION_TOKEN_A}`,
      `agentera://user@organization-invitation#${ORGANIZATION_TOKEN_A}`,
      `agentera://organization-invitation:443#${ORGANIZATION_TOKEN_A}`,
      `agentera://organization-invitation/#${ORGANIZATION_TOKEN_A}`,
      `agentera://organization-invitation/path#${ORGANIZATION_TOKEN_A}`,
      `agentera://organization-invitation?token=x#${ORGANIZATION_TOKEN_A}`,
      "agentera://organization-invitation#",
      `agentera://organization-invitation#${"A".repeat(42)}`,
      `agentera://organization-invitation#${"B".repeat(43)}`,
      `agentera://organization-invitation#%41${ORGANIZATION_TOKEN_A.slice(1)}`,
      `${ORGANIZATION_LINK_A} `,
      `${ORGANIZATION_LINK_A}#extra`,
    ]) {
      expect(
        parseOrganizationInvitationDeepLink(candidate),
        candidate,
      ).toBeNull();
    }
  });

  it("finds only the last valid Organization invitation argument", () => {
    expect(
      findOrganizationInvitationInArguments([
        "/Applications/Aera.app",
        WORKSPACE_LINK,
        ORGANIZATION_LINK_A,
        "private-noise",
        ORGANIZATION_LINK_B,
      ]),
    ).toBe(ORGANIZATION_TOKEN_B);
    expect(
      findOrganizationInvitationInArguments([WORKSPACE_LINK, "--flag"]),
    ).toBeNull();
  });

  it("uses one tagged volatile inbox and lets a newer kind replace the older", () => {
    const inbox = new WorkspaceInvitationInbox();
    const all = vi.fn();
    const workspaces = vi.fn();
    const organizations = vi.fn();
    inbox.subscribeAny(all);
    inbox.subscribe(workspaces);
    inbox.subscribeOrganization(organizations);

    expect(inbox.receiveDeepLink(WORKSPACE_LINK)).toBe(true);
    expect(inbox.peekAny()).toEqual({
      kind: "workspace",
      token: WORKSPACE_TOKEN,
    });
    expect(inbox.peek()).toEqual({ token: WORKSPACE_TOKEN });
    expect(inbox.peekOrganization()).toBeNull();

    expect(inbox.receiveDeepLink(ORGANIZATION_LINK_A)).toBe(true);
    expect(inbox.peekAny()).toEqual({
      kind: "organization",
      token: ORGANIZATION_TOKEN_A,
    });
    expect(inbox.peek()).toBeNull();
    expect(inbox.peekOrganization()).toEqual({ token: ORGANIZATION_TOKEN_A });
    expect(workspaces).toHaveBeenCalledTimes(1);
    expect(organizations).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenNthCalledWith(1, {
      kind: "workspace",
      token: WORKSPACE_TOKEN,
    });
    expect(all).toHaveBeenNthCalledWith(2, {
      kind: "organization",
      token: ORGANIZATION_TOKEN_A,
    });

    expect(inbox.dismiss(WORKSPACE_TOKEN)).toBe(false);
    expect(inbox.dismissOrganization(ORGANIZATION_TOKEN_B)).toBe(false);
    expect(inbox.clearAcceptedOrganization(ORGANIZATION_TOKEN_A)).toBe(true);
    expect(inbox.peekAny()).toBeNull();
  });

  it("chooses the last valid invitation across both kinds in forwarded arguments", () => {
    const inbox = new WorkspaceInvitationInbox();
    expect(
      inbox.receiveArguments([ORGANIZATION_LINK_A, "--noise", WORKSPACE_LINK]),
    ).toBe(true);
    expect(inbox.peekAny()).toEqual({
      kind: "workspace",
      token: WORKSPACE_TOKEN,
    });

    expect(inbox.receiveArguments([WORKSPACE_LINK, ORGANIZATION_LINK_B])).toBe(
      true,
    );
    expect(inbox.peekAny()).toEqual({
      kind: "organization",
      token: ORGANIZATION_TOKEN_B,
    });
  });

  it("has no persistence, browser storage, telemetry, or logging path", () => {
    const organizationSource = readFileSync(
      new URL("./deep-link.ts", import.meta.url),
      "utf8",
    );
    const workspaceSource = readFileSync(
      new URL("../agentera-workspace/deep-link.ts", import.meta.url),
      "utf8",
    );
    expect(`${organizationSource}\n${workspaceSource}`).not.toMatch(
      /node:fs|localStorage|sessionStorage|console\.|telemetry|sqlite|writeFile/i,
    );
  });
});
