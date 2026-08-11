import { describe, expect, it, vi } from "vitest";
import { AgenteraDesktopControlClient } from "./client";

const DEVICE_ID = "10000000-0000-4000-8000-000000000001";
const COMMAND_ID = "20000000-0000-4000-8000-000000000002";

describe("AgenteraDesktopControlClient", () => {
  it("posts an authenticated heartbeat without private identity or content fields", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AgenteraDesktopControlClient({
      origin: "https://cloud.example.test",
      getAccessToken: () => "main-process-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          instance_id: DEVICE_ID,
          accepted_at: "2026-08-11T00:00:00.000Z",
          next_heartbeat_seconds: 60,
          effective_status: "online",
          server_time: "2026-08-11T00:00:00.000Z",
          command: null,
        });
      },
    });

    await client.heartbeat({
      display_name: "Aera Mac",
      client_version: "0.8.0",
      platform: "darwin",
      arch: "arm64",
      capabilities: ["diagnostics.health.read"],
      uptime_seconds: 10,
    });

    expect(calls[0]?.url).toBe(
      "https://cloud.example.test/api/v1/devices/current/desktop-control/heartbeat",
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer main-process-token",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.stringify(calls[0]?.init?.body)).not.toMatch(
      /user_id|device_id|prompt|conversation|memory|path|log|secret|token|credential/i,
    );
  });

  it("rejects malformed Cloud success payloads and does not echo response text", async () => {
    const client = new AgenteraDesktopControlClient({
      origin: "https://cloud.example.test",
      getAccessToken: () => "token",
      fetch: async () =>
        new Response(JSON.stringify({ leaked: "secret" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      client.heartbeat({
        display_name: "Aera Mac",
        client_version: "0.8.0",
        platform: "darwin",
        arch: "arm64",
        capabilities: ["diagnostics.health.read"],
        uptime_seconds: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.heartbeat({
        display_name: "Aera Mac",
        client_version: "0.8.0",
        platform: "darwin",
        arch: "arm64",
        capabilities: ["diagnostics.health.read"],
        uptime_seconds: 0,
      }),
    ).rejects.not.toThrow("secret");
  });

  it("requires an access token immediately before sending", async () => {
    const fetcher = vi.fn();
    const client = new AgenteraDesktopControlClient({
      origin: "https://cloud.example.test",
      getAccessToken: () => null,
      fetch: fetcher,
    });
    await expect(
      client.submitResult(COMMAND_ID, {
        state: "running",
        code: null,
        summary: null,
      }),
    ).rejects.toMatchObject({ code: "session_revoked", status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limits oversized error bodies to a safe code", async () => {
    const client = new AgenteraDesktopControlClient({
      origin: "https://cloud.example.test",
      getAccessToken: () => "token",
      fetch: async () =>
        new Response("x".repeat(1024 * 1024 + 1), { status: 503 }),
    });
    await expect(
      client.heartbeat({
        display_name: "Aera Mac",
        client_version: "0.8.0",
        platform: "darwin",
        arch: "arm64",
        capabilities: ["diagnostics.health.read"],
        uptime_seconds: 0,
      }),
    ).rejects.toMatchObject({ code: "response_too_large", status: 503 });
  });
});
