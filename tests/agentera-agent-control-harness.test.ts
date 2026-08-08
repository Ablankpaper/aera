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
  it("captures a bounded redacted deadlock signal on demand", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "postgresFailureDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    let reads = 0;
    const result = diagnostics(
      {
        composeStarted: true,
        composeProject: "aera-e2e-owned",
        cloudRoot: "/tmp/aera-e2e-owned/cloud",
      },
      () => {
        reads += 1;
        return [
          "2026-08-08 01:52:52.100 UTC [80] LOG: checkpoint starting: time",
          "2026-08-08 01:52:54.712 UTC [87] ERROR: deadlock detected password=MUST_NOT_LEAK",
          "2026-08-08 01:52:54.712 UTC [87] DETAIL: Process 87 waits for ShareLock on transaction 1843; blocked by process 91.",
          '2026-08-08 01:52:54.712 UTC [87] CONTEXT: while updating tuple (0,42) in relation "organization_memberships"',
          "2026-08-08 01:52:54.713 UTC [87] STATEMENT: UPDATE organization_memberships SET role = $3 WHERE organization_id = $1 AND user_id = $2",
        ].join("\n");
      },
    );

    expect(reads).toBe(1);
    expect(result).toEqual({
      capture: "captured",
      deadlockDetected: true,
      lines: [
        "2026-08-08 01:52:54.712 UTC [87] ERROR: deadlock detected password=[redacted]",
        "2026-08-08 01:52:54.712 UTC [87] DETAIL: Process 87 waits for ShareLock on transaction 1843; blocked by process 91.",
        '2026-08-08 01:52:54.712 UTC [87] CONTEXT: while updating tuple (0,42) in relation "organization_memberships"',
      ],
    });
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK");
    expect(JSON.stringify(result)).not.toContain("checkpoint");
    expect(JSON.stringify(result)).not.toContain("STATEMENT:");
  });

  it("does not read logs when the run-owned Compose stack is unavailable", () => {
    const diagnostics = Reflect.get(
      agentControlHarness,
      "postgresFailureDiagnostics",
    ) as unknown;
    expect(diagnostics).toBeTypeOf("function");
    if (typeof diagnostics !== "function") return;

    let reads = 0;
    const result = diagnostics(
      {
        composeStarted: false,
        composeProject: "aera-e2e-owned",
        cloudRoot: "/tmp/aera-e2e-owned/cloud",
      },
      () => {
        reads += 1;
        return "ERROR: deadlock detected";
      },
    );

    expect(reads).toBe(0);
    expect(result).toEqual({
      capture: "unavailable",
      deadlockDetected: false,
      lines: [],
    });
  });
});
