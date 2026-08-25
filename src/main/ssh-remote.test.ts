import { describe, expect, it, vi } from "vitest";
import {
  buildGatewayStartCommand,
  upsertEnvLine,
  buildGatewayStatusCommand,
  buildGatewayStopCommand,
  isUsableApiServerKey,
  sshGatewayApiReady,
  sshResolveDashboardPort,
  sshStartGatewayAndWaitApiReady,
  sshWaitGatewayApiReady,
} from "./ssh-remote";
import type { SshConfig } from "./ssh-tunnel";

const dummySsh: SshConfig = {
  host: "h",
  port: 22,
  username: "u",
  keyPath: "",
  remotePort: 8642,
  localPort: 18642,
};

describe("SSH remote profile gateway commands", () => {
  it("uses the default systemd-aware gateway command for the default profile", () => {
    const command = buildGatewayStartCommand();

    expect(command).toContain("systemctl start hermes.service");
    // Default profile resolves the CLI via the venv/launcher probe in the
    // non-systemd branch (not bare `hermes`), so it works when `hermes` is not
    // on the non-interactive SSH PATH.
    expect(command).toContain("venv/bin/hermes");
    expect(command).not.toContain("--profile");
  });

  it("launches the gateway with `run`, not the service-only `start`", () => {
    // `gateway start` drives the systemd/launchd service and fails with
    // "Gateway service is not installed" on a bare VPS; `gateway run` launches
    // the gateway (and its api_server) directly. The systemd branch still uses
    // `systemctl start`, but the CLI invocation must never be `gateway start`.
    // CLI args are shell-quoted individually, so the invocation appears as the
    // quoted token `'run'` (never the service-only `'start'`). The systemd
    // branch's `systemctl start` is unquoted and unaffected.
    const command = buildGatewayStartCommand();
    expect(command).toContain("'run'");
    expect(command).not.toContain("'start'");

    const named = buildGatewayStartCommand("research");
    expect(named).toContain("'run'");
    expect(named).not.toContain("'start'");
  });

  it("targets the named profile gateway pid and CLI flag", () => {
    const start = buildGatewayStartCommand("research");
    const status = buildGatewayStatusCommand("research");
    const stop = buildGatewayStopCommand("research");

    expect(start).toContain("$HOME/.hermes/profiles/research");
    expect(start).toContain("--profile");
    expect(start).toContain("research");
    expect(status).toContain("$HOME/.hermes/profiles/research/gateway.pid");
    expect(stop).toContain("$HOME/.hermes/profiles/research/gateway.pid");
  });
});

describe("SSH api_server key provisioning", () => {
  it("rejects empty, short, and placeholder keys so the api_server can bind", () => {
    // The gateway api_server refuses to bind with a missing/short/placeholder
    // key, so these must trigger provisioning of a fresh key.
    expect(isUsableApiServerKey("")).toBe(false);
    expect(isUsableApiServerKey("   ")).toBe(false);
    expect(isUsableApiServerKey("short")).toBe(false);
    expect(isUsableApiServerKey("0123456789abcde")).toBe(false); // 15 chars
    expect(isUsableApiServerKey("changeme")).toBe(false);
    expect(isUsableApiServerKey("API_SERVER_KEY")).toBe(false);
    expect(isUsableApiServerKey("your-api-key")).toBe(false);
  });

  it("accepts a real key (>=16 chars, non-placeholder)", () => {
    expect(isUsableApiServerKey("0123456789abcdef")).toBe(true); // 16 chars
    expect(
      isUsableApiServerKey("hermes-remote-test-key-0123456789abcdef"),
    ).toBe(true);
    expect(isUsableApiServerKey(`  ${"a".repeat(48)}  `)).toBe(true);
  });
});

describe("SSH gateway API readiness", () => {
  it("performs one API probe even when the status timeout has no retry window", async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValue(101);
    const exec = vi.fn(async () => "200\n");

    await expect(
      sshWaitGatewayApiReady(dummySsh, 9751, 0, {
        now,
        exec,
        delay: vi.fn(async () => undefined),
      }),
    ).resolves.toBe(true);

    expect(exec).toHaveBeenCalledOnce();
  });

  it("does not treat a live remote PID as ready when the API is unhealthy", async () => {
    const gatewayStatus = vi.fn(async () => true);
    const resolveApiServerPort = vi.fn(async () => 9751);
    const waitGatewayApiReady = vi.fn(async () => false);

    await expect(
      sshGatewayApiReady(dummySsh, "research", 0, {
        gatewayStatus,
        startGateway: vi.fn(),
        resolveApiServerPort,
        waitGatewayApiReady,
      }),
    ).resolves.toBe(false);

    expect(gatewayStatus).toHaveBeenCalledWith(dummySsh, "research");
    expect(resolveApiServerPort).toHaveBeenCalledWith(dummySsh, "research");
    expect(waitGatewayApiReady).toHaveBeenCalledWith(dummySsh, 9751, 0);
  });

  it("reports a remote start as ready only after the API health probe", async () => {
    const startGateway = vi.fn(async () => undefined);
    const resolveApiServerPort = vi.fn(async () => 9751);
    const waitGatewayApiReady = vi.fn(async () => false);

    await expect(
      sshStartGatewayAndWaitApiReady(dummySsh, "research", 30_000, {
        gatewayStatus: vi.fn(),
        startGateway,
        resolveApiServerPort,
        waitGatewayApiReady,
      }),
    ).resolves.toEqual({ ready: false, port: 9751 });

    expect(startGateway).toHaveBeenCalledWith(dummySsh, "research");
    expect(waitGatewayApiReady).toHaveBeenCalledWith(dummySsh, 9751, 30_000);
  });
});

describe("SSH dashboard transport", () => {
  it("resolves the default profile dashboard port to 9119 without SSH", async () => {
    // Default profile returns the fixed dashboard port synchronously (no remote
    // round-trip), so the desktop tunnels to the right port even before any
    // gateway/dashboard call.
    await expect(sshResolveDashboardPort(dummySsh)).resolves.toBe(9119);
    await expect(sshResolveDashboardPort(dummySsh, "default")).resolves.toBe(
      9119,
    );
  });
});

describe("remote .env upsert", () => {
  it("replaces an existing key in place", () => {
    const out = upsertEnvLine(
      "A=1\nAPI_SERVER_KEY=old\nB=2",
      "API_SERVER_KEY",
      "new",
    );
    expect(out).toBe("A=1\nAPI_SERVER_KEY=new\nB=2");
  });

  it("drops stale duplicate lines so the last-wins reader sees the new value", () => {
    // Pre-dedup desktops appended a fresh API_SERVER_KEY on every connect race.
    // dotenv (and sshReadEnv) are last-wins, so rewriting only the FIRST line
    // left a stale later duplicate winning in the gateway — the desktop cached
    // the new key, the gateway kept the old one, and /v1 401'd forever.
    const out = upsertEnvLine(
      "API_SERVER_KEY=one\nX=y\nAPI_SERVER_KEY=two\nAPI_SERVER_KEY=three",
      "API_SERVER_KEY",
      "new",
    );
    expect(out).toBe("API_SERVER_KEY=new\nX=y");
  });

  it("revives a commented-out line instead of appending a second entry", () => {
    const out = upsertEnvLine(
      "# API_SERVER_KEY=old\nB=2",
      "API_SERVER_KEY",
      "new",
    );
    expect(out).toBe("API_SERVER_KEY=new\nB=2");
  });

  it("appends when the key is absent and seeds an empty file", () => {
    expect(upsertEnvLine("A=1", "API_SERVER_KEY", "k")).toBe(
      "A=1\nAPI_SERVER_KEY=k",
    );
    expect(upsertEnvLine("", "API_SERVER_KEY", "k")).toBe("API_SERVER_KEY=k\n");
  });

  it("does not touch keys that merely share a prefix", () => {
    const out = upsertEnvLine(
      "API_SERVER_KEY_BACKUP=keep\nAPI_SERVER_KEY=old",
      "API_SERVER_KEY",
      "new",
    );
    expect(out).toBe("API_SERVER_KEY_BACKUP=keep\nAPI_SERVER_KEY=new");
  });
});
