import { expect, test } from "playwright/test";

import type {
  AgenteraOrganizationResult,
  OrganizationInvitationCreation,
  OrganizationPublicState,
  OrganizationSummary,
} from "../../src/shared/agentera-organization";
import {
  agentControlExchangeDiagnostics,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  launchAgentControlDevice,
  type AgentControlDevice,
  type AgentControlDeviceName,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const OWNER_PHONE = "+8613900000061";
const MEMBER_PHONE = "+8613900000062";
const OBSERVER_PHONE = "+8613900000063";

type OrganizationMethod =
  | "create"
  | "createInvitation"
  | "refresh"
  | "revokeInvitation";

interface AccountFixture {
  device: AgentControlDevice;
  userId: string;
}

let harness: AgentControlHarness | null = null;

test.setTimeout(360_000);

function diagnostics(): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: harness?.devices.flatMap((device) =>
      deviceProcessDiagnostics(device),
    ),
  });
}

function unwrapOrganization<T>(result: AgenteraOrganizationResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Organization invitation operation failed: ${result.errorCode}; ${diagnostics()}`,
    );
  }
  return result.data;
}

async function invokeOrganization<T>(
  device: AgentControlDevice,
  method: OrganizationMethod,
  ...args: unknown[]
): Promise<AgenteraOrganizationResult<T>> {
  return device.page.evaluate(
    async ({ requestedMethod, requestedArgs }) => {
      const api = window.agenteraOrganization as unknown as Record<
        string,
        (...parameters: unknown[]) => Promise<unknown>
      >;
      return api[requestedMethod](...requestedArgs) as Promise<
        AgenteraOrganizationResult<T>
      >;
    },
    { requestedMethod: method, requestedArgs: args },
  );
}

async function resetBrowserIdentity(
  harnessValue: AgentControlHarness,
): Promise<void> {
  await harnessValue.browserPage.context().close();
  harnessValue.browserPage = await (
    await harnessValue.browser.newContext({ locale: "en-US" })
  ).newPage();
}

async function dismissModelSetupPrompt(
  device: AgentControlDevice,
): Promise<void> {
  const modelSetupPrompt = device.page.getByRole("dialog").filter({
    hasText:
      /(?:No AI model is configured for this session|当前会话还没有配置智能体大模型)/u,
  });
  await modelSetupPrompt
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  if (await modelSetupPrompt.isVisible()) {
    await modelSetupPrompt
      .getByRole("button", { name: /^(?:Later|稍后)$/u })
      .click();
  }
}

async function launchAccount(
  harnessValue: AgentControlHarness,
  name: AgentControlDeviceName,
  phone: string,
  resetBrowser: boolean,
): Promise<AccountFixture> {
  if (resetBrowser) await resetBrowserIdentity(harnessValue);
  harnessValue.phone = phone;
  const device = await launchAgentControlDevice(harnessValue, name);
  await authenticateFirstAgentControlDevice(harnessValue, device);
  await claimDefaultProfile(device);
  await dismissModelSetupPrompt(device);
  const state = await device.page.evaluate(() =>
    window.agenteraAuth.getState(),
  );
  if (state.status !== "authenticated") {
    throw new Error(`Account ${name} did not authenticate.`);
  }
  return { device, userId: state.userId };
}

async function deliverInvitation(
  device: AgentControlDevice,
  inviteUrl: string,
): Promise<void> {
  await device.app.evaluate(({ app }, url) => {
    app.emit("open-url", { preventDefault: () => undefined } as never, url);
  }, inviteUrl);
  await expect(
    device.page.locator(".organization-invitation-gate-dialog"),
  ).toBeVisible();
}

async function acceptVisibleInvitation(
  device: AgentControlDevice,
): Promise<void> {
  await device.page
    .getByRole("button", { name: /^(?:Accept invitation|接受邀请)$/u })
    .click();
}

async function expectInvitationFailure(
  device: AgentControlDevice,
  inviteUrl: string,
  message: RegExp,
): Promise<void> {
  await deliverInvitation(device, inviteUrl);
  await acceptVisibleInvitation(device);
  await expect(device.page.getByRole("alert")).toHaveText(message);
  await device.page
    .getByRole("button", { name: /^(?:Dismiss invitation|忽略邀请)$/u })
    .click();
  await expect(
    device.page.locator(".organization-invitation-gate-dialog"),
  ).toBeHidden();
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
});

// @lat: [[agentera-organizations#Invitations#Independent live proof]]
test("copies and consumes a one-time Organization invitation against real Cloud", async () => {
  if (!harness) throw new Error("Invitation E2E harness is unavailable.");

  const owner = await launchAccount(harness, "A", OWNER_PHONE, false);
  const organization = unwrapOrganization(
    await invokeOrganization<OrganizationSummary>(owner.device, "create", {
      displayName: "Invitation Live E2E",
    }),
  );

  await owner.device.page
    .locator(".product-space-switcher .workspace-switcher-trigger")
    .click();
  await owner.device.page
    .getByRole("menuitem", { name: /^(?:Manage organization|管理企业)$/u })
    .click();
  const management = owner.device.page.locator(
    ".organization-management-dialog",
  );
  await expect(management).toBeVisible();
  await management
    .getByRole("tab", { name: /^(?:Invitations|邀请)$/u })
    .click();
  await management
    .getByRole("button", { name: /^(?:Create invitation|创建邀请)$/u })
    .click();

  const inviteUrl = await management
    .locator(".workspace-invitation-secret code")
    .textContent();
  if (!inviteUrl) throw new Error("Invitation URL was not rendered.");
  expect(inviteUrl).toMatch(
    /^aera:\/\/organization-invitation#[A-Za-z0-9_-]{43}$/,
  );
  await management
    .getByRole("button", { name: /^(?:Copy invitation link|复制邀请链接)$/u })
    .click();
  await expect(
    management.getByRole("button", {
      name: /^(?:Invitation link copied|邀请链接已复制)$/u,
    }),
  ).toBeVisible();
  expect(
    await owner.device.app.evaluate(({ clipboard }) => clipboard.readText()),
  ).toBe(inviteUrl);

  const member = await launchAccount(harness, "B", MEMBER_PHONE, true);
  await deliverInvitation(member.device, inviteUrl);
  await acceptVisibleInvitation(member.device);
  await expect(
    member.device.page.locator(".organization-invitation-gate-dialog"),
  ).toBeHidden();
  await expect
    .poll(async () =>
      member.device.page.evaluate(async () => {
        const result = await window.agenteraProductSpace.getState();
        return result.ok ? result.data.selected : null;
      }),
    )
    .toEqual({
      kind: "ORGANIZATION",
      organizationId: organization.id,
      role: "member",
    });

  const observer = await launchAccount(harness, "C", OBSERVER_PHONE, true);
  await expectInvitationFailure(
    observer.device,
    inviteUrl,
    /^(?:This one-time invitation has already been used\.|此一次性邀请已经被使用。)$/u,
  );

  const revoked = unwrapOrganization(
    await invokeOrganization<OrganizationInvitationCreation>(
      owner.device,
      "createInvitation",
      { organizationId: organization.id },
    ),
  );
  unwrapOrganization(
    await invokeOrganization<true>(owner.device, "revokeInvitation", {
      organizationId: organization.id,
      invitationId: revoked.invitation.id,
    }),
  );
  await expectInvitationFailure(
    observer.device,
    revoked.inviteUrl,
    /^(?:This invitation was revoked\. Ask for a new link\.|此邀请已被撤销，请让管理员创建新链接。)$/u,
  );

  const organizationState = unwrapOrganization(
    await invokeOrganization<OrganizationPublicState>(owner.device, "refresh"),
  );
  expect(
    organizationState.organizations.find(
      (candidate) => candidate.id === organization.id,
    )?.memberCount,
  ).toBe(2);
  expect(observer.userId).not.toBe(member.userId);
});
