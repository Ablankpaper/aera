// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  buildGatewayStartupDiagnosticScript,
  GATEWAY_STARTUP_TRACE_ENV,
} from "./gateway-startup-diagnostic";

describe("gateway startup boundary diagnostic", () => {
  it("is disabled unless the explicit diagnostic environment variable is set", () => {
    expect(GATEWAY_STARTUP_TRACE_ENV).toBe(
      "AGENTERA_E2E_GATEWAY_STARTUP_TRACE",
    );
  });

  it("dispatches the original gateway module and preserves named profiles", () => {
    const script = buildGatewayStartupDiagnosticScript("research");

    expect(script).toContain("runpy.run_module('hermes_cli.main'");
    expect(script).toContain(
      'sys.argv=["aera-gateway-startup-diagnostic","--profile","research","gateway"]',
    );
    expect(script).toContain("write_pid_file");
    expect(script).toContain("start_gateway");
    expect(script).toContain("dump_traceback_later(5.0,repeat=True");
    expect(script).toContain("stdinIsTty");
    expect(script).toContain("inJob");
  });

  it("keeps trace paths and credentials out of the generated command", () => {
    const script = buildGatewayStartupDiagnosticScript();

    expect(script).toContain("AERA_GATEWAY_STARTUP_TRACE_PATH");
    expect(script).toContain("AERA_GATEWAY_STARTUP_STACK_PATH");
    expect(script).not.toContain("API_SERVER_KEY");
    expect(script).not.toContain("/Users/");
    expect(script).not.toContain("C:\\\\");
  });
});
