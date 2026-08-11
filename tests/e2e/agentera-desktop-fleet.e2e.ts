import { expect, test, type Locator } from "playwright/test";

import {
  acceptedDesktopHeartbeat,
  advanceDesktopControlClock,
  assertNoAdminDesktopCopy,
  authenticateAdminBrowser,
  authenticateDesktop,
  desktopControlRequests,
  launchDesktopWithoutRuntime,
  readCloudCommand,
  readCloudDesktopRows,
} from "./support/agentera-desktop-fleet-harness";
import {
  closeAgentControlHarness,
  createAgentControlHarness,
  desktopFleetAdminEnvironmentDiagnostics,
  launchAgentControlDevice,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

test.setTimeout(900_000);

let harness: AgentControlHarness | null = null;
let device: AgentControlDevice | null = null;

function removeDeviceFromHarness(current: AgentControlDevice): void {
  if (!harness) return;
  const index = harness.devices.indexOf(current);
  if (index >= 0) harness.devices.splice(index, 1);
}

function responseBodyRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commandIdFromMessage(text: string): string {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/iu);
  if (!match) throw new Error(`健康检查提示中没有命令 ID：${text}`);
  return match[0];
}

async function waitForHeartbeat(): Promise<{
  deviceId: string;
  userId: string;
  acceptedAt: string;
}> {
  if (!harness) throw new Error("Desktop Fleet harness is not started.");
  await expect
    .poll(() => acceptedDesktopHeartbeat(desktopControlRequests(harness!)), {
      timeout: 90_000,
      message: "Cloud did not accept a real Desktop heartbeat.",
    })
    .not.toBeNull();
  const heartbeat = acceptedDesktopHeartbeat(desktopControlRequests(harness));
  const deviceId = heartbeat?.deviceId ?? "";
  const acceptedAt = heartbeat?.acceptedAt ?? "";
  const state = await device?.page.evaluate(() =>
    window.agenteraAuth.getState(),
  );
  const userId = typeof state?.userId === "string" ? state.userId : "";
  if (!deviceId || !acceptedAt || !userId) {
    throw new Error(
      `Heartbeat response did not contain bounded identity evidence: ${JSON.stringify(heartbeat)}`,
    );
  }
  return { deviceId, userId, acceptedAt };
}

async function openCloudUserDesktop(
  admin: Awaited<ReturnType<typeof authenticateAdminBrowser>>,
  userId: string,
): Promise<Locator> {
  await admin.page.goto(`${harness!.official!.adminBaseURL}/admin/users`);
  const cloudTab = admin.page.getByText("云端用户", { exact: true });
  try {
    await expect(cloudTab).toBeVisible({ timeout: 5_000 });
  } catch (error) {
    throw new Error(
      `${String(error)}\nDesktop fleet Admin users page diagnostics: ${JSON.stringify(
        {
          url: admin.page.url(),
          bodyText: (await admin.page.locator("body").innerText()).slice(
            0,
            4000,
          ),
        },
      )}`,
    );
  }
  await cloudTab.click();
  await expect(admin.page.getByTestId("cloud-users-table")).toBeVisible();
  const userRow = admin.page.getByRole("row").filter({ hasText: userId });
  await expect(userRow).toBeVisible({ timeout: 60_000 });
  await userRow.getByText(userId, { exact: true }).click();
  await expect(
    admin.page.getByTestId("cloud-user-desktop-table"),
  ).toBeVisible();
  return admin.page.getByTestId("cloud-user-desktop-table");
}

test.afterEach(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  device = null;
});

test("real Desktop stays online, completes health_check, fails without Runtime, then expires offline", async () => {
  harness = await createAgentControlHarness({ desktopFleet: true });
  device = await launchAgentControlDevice(harness, "A");
  await authenticateDesktop(harness, device);

  const identity = await waitForHeartbeat();
  const firstRows = await readCloudDesktopRows(harness);
  const desktopName = firstRows.find(
    (candidate) => candidate.device_id === identity.deviceId,
  )?.display_name;
  expect(firstRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        device_id: identity.deviceId,
        user_id: identity.userId,
        display_name: expect.any(String),
        effective_status: "online",
      }),
    ]),
  );
  expect(desktopName).toBeTruthy();

  const admin = await authenticateAdminBrowser(harness);
  await admin.page.goto(
    `${harness.official!.adminBaseURL}/admin/runtime/instances`,
  );
  await expect(
    admin.page.getByRole("heading", { name: "运行实例", exact: true }),
  ).toBeVisible();
  const row = admin.page.getByRole("row").filter({ hasText: desktopName! });
  try {
    await expect(row).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    const diagnostics = await admin.page.evaluate(async () => {
      const response = await fetch("/api/cloud/v1/listDesktopControlInstances");
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    });
    throw new Error(
      `${String(error)}\nDesktop fleet Admin page diagnostics: ${JSON.stringify(
        {
          url: admin.page.url(),
          bodyText: (await admin.page.locator("body").innerText()).slice(
            0,
            4000,
          ),
        },
      )}\nDesktop fleet Admin API diagnostics: ${JSON.stringify(diagnostics)}\nDesktop fleet Admin environment diagnostics: ${JSON.stringify(
        desktopFleetAdminEnvironmentDiagnostics(harness!.official!.environment),
      )}`,
    );
  }
  await expect(row.getByTestId("desktop-online-status")).toHaveText("在线");
  await expect(admin.page.getByText(/注册码|registration code/i)).toHaveCount(
    0,
  );
  await expect(
    admin.page.getByRole("button", {
      name: /重启|升级|回滚|配置下发|创建注册码/,
    }),
  ).toHaveCount(0);

  const userDesktopTable = await openCloudUserDesktop(admin, identity.userId);
  const userDesktopRow = userDesktopTable
    .getByRole("row")
    .filter({ hasText: desktopName! });
  await expect(userDesktopRow).toBeVisible();
  await expect(userDesktopRow.getByTestId("desktop-online-status")).toHaveText(
    "在线",
  );

  await admin.page.goto(
    `${harness.official!.adminBaseURL}/admin/runtime/instances`,
  );
  const healthRow = admin.page
    .getByRole("row")
    .filter({ hasText: desktopName! });
  await expect(healthRow).toBeVisible();
  await healthRow.getByRole("button", { name: "健康检查" }).click();

  const toast = admin.page.getByText(/健康检查已进入队列/);
  await expect(toast).toBeVisible();
  const commandId = commandIdFromMessage(await toast.innerText());
  try {
    await expect(admin.page.getByTestId("desktop-health-result")).toContainText(
      "HEALTHY",
      {
        timeout: 60_000,
      },
    );
  } catch (error) {
    const runtimeStatus = await device.page.evaluate(async () => {
      const [gatewayRunning, dashboard] = await Promise.all([
        window.hermesAPI.gatewayStatus(),
        window.hermesAPI.dashboardStatus(),
      ]);
      return {
        gatewayRunning,
        dashboardSupported: dashboard.supported,
        dashboardRunning: dashboard.running,
      };
    });
    throw new Error(
      `${String(error)}\nDesktop runtime health diagnostics: ${JSON.stringify(runtimeStatus)}`,
    );
  }
  await expect
    .poll(async () => (await readCloudCommand(harness!, commandId)).state, {
      timeout: 30_000,
    })
    .toBe("succeeded");
  await expect
    .poll(() =>
      desktopControlRequests(harness!, commandId).some(
        (request) =>
          request.path.endsWith(
            `/desktop-control/commands/${commandId}/result`,
          ) && responseBodyRecord(request.body)?.state === "succeeded",
      ),
    )
    .toBe(true);

  await device.app.close();
  removeDeviceFromHarness(device);
  device = await launchDesktopWithoutRuntime(harness, "A");
  await authenticateDesktop(harness, device, true);
  await admin.page.goto(
    `${harness.official!.adminBaseURL}/admin/runtime/instances`,
  );
  const repairedRow = admin.page
    .getByRole("row")
    .filter({ hasText: desktopName! });
  await expect(repairedRow).toBeVisible({ timeout: 60_000 });
  await repairedRow.getByRole("button", { name: "健康检查" }).click();
  const failedToast = admin.page.getByText(/健康检查已进入队列/).last();
  await expect(failedToast).toBeVisible();
  const failedCommandId = commandIdFromMessage(await failedToast.innerText());
  await expect(admin.page.getByTestId("desktop-health-result")).toContainText(
    "RUNTIME_UNAVAILABLE",
    {
      // The command may be created just after the relaunch heartbeat. Allow
      // one full server-directed 60-second interval plus UI polling margin.
      timeout: 90_000,
    },
  );
  await expect
    .poll(
      async () => (await readCloudCommand(harness!, failedCommandId)).state,
      {
        timeout: 30_000,
      },
    )
    .toBe("failed");

  const rowsBeforeOffline = await readCloudDesktopRows(harness);
  const heartbeatBeforeOffline = rowsBeforeOffline.find(
    (item) => item.device_id === identity.deviceId,
  )?.last_heartbeat_at;
  expect(heartbeatBeforeOffline).toBeTruthy();
  await device.app.close();
  removeDeviceFromHarness(device);
  device = null;
  await advanceDesktopControlClock(
    harness,
    new Date(new Date(heartbeatBeforeOffline!).getTime() + 151_000),
  );
  await admin.page.goto(
    `${harness.official!.adminBaseURL}/admin/runtime/instances`,
  );
  const offlineRow = admin.page
    .getByRole("row")
    .filter({ hasText: desktopName! });
  await expect(offlineRow.getByTestId("desktop-online-status")).toHaveText(
    "离线",
    { timeout: 30_000 },
  );
  const rowsAfterOffline = await readCloudDesktopRows(harness);
  expect(
    rowsAfterOffline.find((item) => item.device_id === identity.deviceId)
      ?.last_heartbeat_at,
  ).toBe(heartbeatBeforeOffline);

  const serialized = JSON.stringify({
    payloads: desktopControlRequests(harness).map((request) => ({
      body: request.body,
      responseBody: request.responseBody,
    })),
    rows: rowsAfterOffline,
  });
  for (const marker of [
    "MEMORY.md",
    "USER.md",
    "sessions/authoring.json",
    "files/private.txt",
    "SKILL.md",
  ]) {
    expect(serialized).not.toContain(marker);
  }
  expect(serialized).not.toMatch(
    /prompt|conversation|memory|workspace|path|raw_log|secret|token|credential|private_key/i,
  );
  assertNoAdminDesktopCopy(harness.official!.adminRoot);
});
