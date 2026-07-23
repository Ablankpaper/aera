// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  AgenteraOfficialQualityClient,
  AgenteraOfficialQualityClientError,
} from "./client";

const EVENT_ID = "019f0000-0000-7000-8000-000000000001";

function envelopeJSON(): string {
  return JSON.stringify({
    protocol_version: 1,
    consent_version: 1,
    event_id: EVENT_ID,
    platform_id: "30000000-0000-4000-8000-000000000001",
    definition_id: "40000000-0000-4000-8000-000000000001",
    version_id: "50000000-0000-4000-8000-000000000001",
    release_id: "60000000-0000-4000-8000-000000000001",
    release_revision_id: "70000000-0000-4000-8000-000000000001",
    desktop_version: "0.7.3",
    runtime_version: "v0.18.2-agentera.1",
    event_day: "2026-07-23",
    kind: "metric",
    result: "success",
    latency_bucket: "1s_5s",
    total_token_bucket: "1_1k",
    crash_code: null,
    feedback_rating: null,
    feedback_reason_codes: [],
    binding_proof: "90000000-0000-4000-8000-000000000001",
    device_signature: "A".repeat(86),
  });
}

describe("AgenteraOfficialQualityClient", () => {
  it("posts the exact canonical event with bearer authentication", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { event_id: EVENT_ID, status: "accepted" },
        { status: 202 },
      ),
    );
    const client = new AgenteraOfficialQualityClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "quality-access-token",
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    await expect(client.uploadEvent(envelopeJSON())).resolves.toEqual({
      eventId: EVENT_ID,
      status: "accepted",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      URL | RequestInfo,
      RequestInit,
    ];
    expect(String(url)).toBe(
      "http://127.0.0.1:8086/api/v1/official-agent-quality/events",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: envelopeJSON(),
      headers: {
        authorization: "Bearer quality-access-token",
        "content-type": "application/json",
      },
    });
  });

  it("maps retryable and terminal server errors without echoing response bodies", async () => {
    const secret = "private-server-body";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "service_unavailable", note: secret },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "privacy_rejected", note: secret },
          { status: 400 },
        ),
      );
    const client = new AgenteraOfficialQualityClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "quality-access-token",
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    const retryable = await client
      .uploadEvent(envelopeJSON())
      .catch((error) => error);
    expect(retryable).toBeInstanceOf(AgenteraOfficialQualityClientError);
    expect(retryable).toMatchObject({
      code: "service_unavailable",
      retryable: true,
    });
    expect(String(retryable)).not.toContain(secret);

    const rejected = await client
      .uploadEvent(envelopeJSON())
      .catch((error) => error);
    expect(rejected).toMatchObject({
      code: "privacy_rejected",
      retryable: false,
    });
    expect(String(rejected)).not.toContain(secret);
  });

  it("fails closed without an access token and syncs exact consent versions", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          purpose: "official_quality_metrics",
          consent_version: 2,
          state: "revoked",
          revision: 4,
          recorded_at: "2026-07-23T12:00:00Z",
          replayed: false,
        },
        { status: 200 },
      ),
    );
    const missing = new AgenteraOfficialQualityClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => null,
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    await expect(missing.uploadEvent(envelopeJSON())).rejects.toMatchObject({
      code: "authentication_required",
      retryable: true,
    });
    expect(fetcher).not.toHaveBeenCalled();

    const client = new AgenteraOfficialQualityClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "quality-access-token",
      fetch: fetcher as typeof fetch,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    await expect(
      client.setConsent("official_quality_metrics", false, 2),
    ).resolves.toMatchObject({
      purpose: "official_quality_metrics",
      consentVersion: 2,
      state: "revoked",
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      URL | RequestInfo,
      RequestInit,
    ];
    expect(String(url)).toContain("/consents/official_quality_metrics/revoke");
    expect(init?.body).toBe('{"consent_version":2}');
  });
});
