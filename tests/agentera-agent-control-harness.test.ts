import { describe, expect, it } from "vitest";

import * as agentControlHarness from "./e2e/support/agentera-agent-control-harness";

const { RUNTIME_INSTALL_WAIT_OPTIONS } = agentControlHarness;

describe("Agent Control Runtime installation wait contract", () => {
  it("uses the installation-aware 180 second poll window", () => {
    expect(RUNTIME_INSTALL_WAIT_OPTIONS).toEqual({
      timeout: 180_000,
      intervals: [250, 500, 1_000],
    });
  });
});

describe("Agent Control Organization proxy diagnostics", () => {
  it("reports upstream member failures without request bodies", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "organizationRequestDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    const privateBody = {
      role: "member",
      expected_revision: 2,
      private_marker: "MUST_NOT_LEAK",
    };
    const result = diagnostics({
      requests: [
        {
          method: "PATCH",
          path: "/api/v1/organizations/aa4fc1f1-5d46-4dc8-bc3f-a84adf72d846/members/dd48b3aa-54e8-41f7-ac1a-11b8385d5fcd",
          contentType: "application/json",
          body: privateBody,
          receivedAt: "2026-08-08T01:53:05.000Z",
          responseSource: "upstream",
          responseStatus: 503,
          responseDurationMs: 1013,
          responseBody: {
            error: {
              code: "service_unavailable",
              request_id: "22791b60-3753-46ca-9e00-deea7247da79",
              private_detail: "MUST_NOT_LEAK",
            },
          },
        },
      ],
    });

    expect(result).toEqual([
      {
        method: "PATCH",
        path: "/api/v1/organizations/{organizationId}/members/{userId}",
        receivedAt: "2026-08-08T01:53:05.000Z",
        responseSource: "upstream",
        responseStatus: 503,
        responseDurationMs: 1013,
        errorCode: "service_unavailable",
        requestId: "22791b60-3753-46ca-9e00-deea7247da79",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK");
  });
});

describe("Agent Control Postgres failure diagnostics", () => {
  it("extracts sanitized deadlock signals from the captured Postgres tail", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "postgresFailureDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    const tail = [
      "2026-08-08 01:52:52.100 UTC [80] LOG:  checkpoint starting: time",
      "2026-08-08 01:52:54.712 UTC [87] ERROR:  deadlock detected",
      "2026-08-08 01:52:54.712 UTC [87] DETAIL:  Process 87 waits for ShareLock on transaction 1843; blocked by process 91.",
      "\tProcess 91 waits for ShareLock on transaction 1842; blocked by process 87.",
      '2026-08-08 01:52:54.712 UTC [87] CONTEXT:  while updating tuple (0,42) in relation "organization_memberships"',
      "2026-08-08 01:52:54.713 UTC [87] STATEMENT:  UPDATE organization_memberships SET role = $3, revision = revision + 1 WHERE organization_id = $1 AND user_id = $2",
      "2026-08-08 01:52:55.004 UTC [80] LOG:  checkpoint complete: wrote 2 buffers",
    ].join("\n");
    const result = diagnostics({
      postgresLogTail: tail,
      postgresLogProcess: { exitCode: null },
    });

    expect(result).toEqual({
      capture: "active",
      deadlockDetected: true,
      lines: [
        "2026-08-08 01:52:54.712 UTC [87] ERROR:  deadlock detected",
        "2026-08-08 01:52:54.712 UTC [87] DETAIL:  Process 87 waits for ShareLock on transaction 1843; blocked by process 91.",
        "Process 91 waits for ShareLock on transaction 1842; blocked by process 87.",
        '2026-08-08 01:52:54.712 UTC [87] CONTEXT:  while updating tuple (0,42) in relation "organization_memberships"',
        "2026-08-08 01:52:54.713 UTC [87] STATEMENT:  UPDATE organization_memberships SET role = $3, revision = revision + 1 WHERE organization_id = $1 AND user_id = $2",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("checkpoint");
  });

  it("reports an unavailable capture without inventing evidence", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "postgresFailureDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    expect(
      diagnostics({ postgresLogTail: "", postgresLogProcess: null }),
    ).toEqual({ capture: "unavailable", deadlockDetected: false, lines: [] });
  });
});

describe("Agent Control Cloud output diagnostics", () => {
  it("bounds and redacts the captured Cloud output tail", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "cloudOutputDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    const lines = Array.from(
      { length: 40 },
      (_, index) =>
        `2026-08-08T01:52:${String(index).padStart(2, "0")}Z noise line ${index}`,
    );
    lines.push(
      'level=panic msg="store open failed" dsn="postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:5432/aera_cloud?sslmode=disable"',
    );
    lines.push("redis dial password=aera-cloud-dev-only failed");
    const result = diagnostics({ cloudOutputTail: lines.join("\n") });

    expect(result.captured).toBe(true);
    expect(result.tail).toHaveLength(16);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("aera-cloud-dev-only");
    expect(serialized).not.toContain("noise line 10");
    expect(serialized).toContain("postgres://[redacted]");
    expect(serialized).toContain("password=[redacted]");
    expect(serialized).toContain("level=panic");
  });

  it("reports an empty Cloud output capture honestly", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "cloudOutputDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    expect(diagnostics({ cloudOutputTail: "" })).toEqual({
      captured: false,
      tail: [],
    });
  });
});
