import { describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type { DesktopControlTerminalResult } from "./store";
import {
  AgenteraDesktopControlCoordinator,
  type DesktopControlClientPort,
  type DesktopControlJournalPort,
} from "./coordinator";
import {
  AgenteraDesktopControlError,
  type DesktopCommand,
  type DesktopCommandResultRequest,
  type DesktopHeartbeatReceipt,
  type DesktopHeartbeatRequest,
} from "./client";
import type { DesktopControlJournalRecord } from "./store";

const USER_A = "10000000-0000-4000-8000-000000000001";
const DEVICE_A = "20000000-0000-4000-8000-000000000002";
const USER_B = "30000000-0000-4000-8000-000000000003";
const DEVICE_B = "40000000-0000-4000-8000-000000000004";
const COMMAND_ID = "50000000-0000-4000-8000-000000000005";

describe("AgenteraDesktopControlCoordinator", () => {
  // @lat: [[lat.md/agentera-desktop-control#Auth-bound heartbeat]]
  it("sends immediately for an authenticated device without inventing a health result", async () => {
    const auth = new AuthFixture();
    const heartbeat = vi.fn(async (_input: unknown) => receipt());
    const coordinator = fixture(auth, { heartbeat, submitResult: vi.fn() });
    coordinator.start();

    auth.publish(authenticated(USER_A, DEVICE_A));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));

    expect(heartbeat.mock.calls[0]?.[0]).not.toHaveProperty("health");
    expect(coordinator.getPublicState()).toMatchObject({
      status: "online",
      lastErrorCode: null,
    });
    await coordinator.close();
  });

  it("runs one fixed health command and persists before terminal delivery", async () => {
    const auth = new AuthFixture();
    const journal = new MemoryJournal();
    const submitResult = vi.fn(
      async (
        _id: string,
        body: DesktopCommandResultRequest,
      ): Promise<DesktopCommand> => ({
        command_id: COMMAND_ID,
        type: "health_check" as const,
        state: body.state,
        expires_at: "2026-08-11T01:00:00.000Z",
      }),
    );
    const coordinator = fixture(
      auth,
      {
        heartbeat: vi.fn(async () =>
          receipt({
            command_id: COMMAND_ID,
            type: "health_check",
            state: "claimed",
            expires_at: "2026-08-11T01:00:00.000Z",
          }),
        ),
        submitResult,
      },
      journal,
    );
    coordinator.start();
    auth.publish(authenticated(USER_A, DEVICE_A));

    await vi.waitFor(() => expect(submitResult).toHaveBeenCalledTimes(2));
    expect(submitResult.mock.calls.map((call) => call[1]?.state)).toEqual([
      "running",
      "succeeded",
    ]);
    expect(journal.events).toEqual([
      "running:50000000-0000-4000-8000-000000000005",
      "terminal:50000000-0000-4000-8000-000000000005",
      "delivered:50000000-0000-4000-8000-000000000005",
    ]);
    expect(coordinator.getPublicState().lastHealth?.code).toBe("HEALTHY");
    await coordinator.close();
  });

  it("retries a transient heartbeat after five seconds", async () => {
    vi.useFakeTimers();
    const auth = new AuthFixture();
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(
        new AgenteraDesktopControlError(503, "service_unavailable"),
      )
      .mockResolvedValueOnce(receipt());
    const coordinator = fixture(auth, { heartbeat, submitResult: vi.fn() });
    coordinator.start();
    auth.publish(authenticated(USER_A, DEVICE_A));
    await vi.runAllTicks();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(coordinator.getPublicState().status).toBe("online");
    await coordinator.close();
    vi.useRealTimers();
  });

  it("aborts the old principal before starting the new account", async () => {
    const auth = new AuthFixture();
    let aborted = 0;
    const heartbeat = vi.fn(
      (
        _input: DesktopHeartbeatRequest,
        signal?: AbortSignal,
      ): Promise<DesktopHeartbeatReceipt> => {
        if (heartbeat.mock.calls.length === 1) {
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted += 1;
              resolve(receipt());
            });
          });
        }
        return Promise.resolve(receipt());
      },
    );
    const coordinator = fixture(auth, { heartbeat, submitResult: vi.fn() });
    coordinator.start();
    auth.publish(authenticated(USER_A, DEVICE_A));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    auth.publish(authenticated(USER_B, DEVICE_B));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    expect(aborted).toBe(1);
    await coordinator.close();
  });
});

function authenticated(
  userId: string,
  deviceId: string,
): AgenteraAuthPublicState {
  return {
    status: "authenticated",
    userId,
    deviceId,
    personalSpaceId: "60000000-0000-4000-8000-000000000006",
    offlineExpiresAt: "2026-08-12T00:00:00.000Z",
    cloudAvailable: true,
  };
}

class AuthFixture {
  private state: AgenteraAuthPublicState = { status: "checking" };
  private listeners = new Set<(state: AgenteraAuthPublicState) => void>();
  getPublicState = (): AgenteraAuthPublicState => this.state;
  subscribe = (
    listener: (state: AgenteraAuthPublicState) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(state: AgenteraAuthPublicState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class MemoryJournal implements DesktopControlJournalPort {
  readonly events: string[] = [];
  private record: {
    userId: string;
    deviceId: string;
    commandId: string;
    state: "running" | "terminal";
    result?: DesktopControlTerminalResult;
    createdAt: string;
    updatedAt: string;
  } | null = null;
  listPending(): DesktopControlJournalRecord[] {
    return this.record ? [this.record] : [];
  }
  markRunning(
    principal: { userId: string; deviceId: string },
    commandId: string,
  ): void {
    this.events.push(`running:${commandId}`);
    this.record = {
      ...principal,
      commandId,
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  saveTerminal(
    principal: { userId: string; deviceId: string },
    commandId: string,
    result: DesktopControlTerminalResult,
  ): void {
    this.events.push(`terminal:${commandId}`);
    this.record = {
      ...principal,
      commandId,
      state: "terminal",
      result,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  markDelivered(
    _principal: { userId: string; deviceId: string },
    commandId: string,
  ): void {
    this.events.push(`delivered:${commandId}`);
    this.record = null;
  }
}

function fixture(
  auth: AuthFixture,
  client: DesktopControlClientPort,
  journal: DesktopControlJournalPort = new MemoryJournal(),
): AgenteraDesktopControlCoordinator {
  return new AgenteraDesktopControlCoordinator({
    auth,
    client,
    journal,
    health: {
      run: async () => ({
        state: "succeeded",
        code: "HEALTHY",
        summary: {
          desktop_status: "healthy",
          runtime_status: "healthy",
          gateway_status: "healthy",
          code: "HEALTHY",
          duration_ms: 1,
        },
      }),
    },
    getHeartbeatMetadata: () => ({
      display_name: "Aera Mac",
      client_version: "0.8.0",
      platform: "darwin",
      arch: "arm64",
      capabilities: ["diagnostics.health.read"],
      uptime_seconds: 10,
    }),
  });
}

function receipt(
  command: DesktopCommand | null = null,
): DesktopHeartbeatReceipt {
  return {
    instance_id: DEVICE_A,
    accepted_at: "2026-08-11T00:00:00.000Z",
    next_heartbeat_seconds: 60,
    effective_status: "online" as const,
    server_time: "2026-08-11T00:00:00.000Z",
    command,
  };
}
