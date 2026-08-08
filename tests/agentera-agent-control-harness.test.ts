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
