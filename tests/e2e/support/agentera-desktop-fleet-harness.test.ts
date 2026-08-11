import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as agentControlHarness from "./agentera-agent-control-harness";
import * as desktopFleetHarness from "./agentera-desktop-fleet-harness";
import type { AgentControlHarness } from "./agentera-agent-control-harness";

import {
  assertOwnedCleanupTarget,
  desktopFleetOwnedPaths,
  removeRunOwnedRuntime,
  resolveDesktopFleetRepositories,
} from "./agentera-desktop-fleet-harness";

describe("Desktop Fleet E2E harness boundaries", () => {
  // @lat: [[lat.md/agentera-desktop-control#Real cross-repository delivery gate]]
  it("emits an Admin seed script without CommonJS-incompatible top-level await", () => {
    const buildSeedScript = (
      agentControlHarness as typeof agentControlHarness & {
        buildDesktopFleetAdminSeedScript?: (
          configPath: string,
          payloadModulePath: string,
        ) => string;
      }
    ).buildDesktopFleetAdminSeedScript;

    expect(buildSeedScript).toBeTypeOf("function");
    const script = buildSeedScript!(
      "/tmp/aera-admin/src/payload.config.ts",
      "/tmp/aera-admin/node_modules/payload/dist/index.js",
    );
    expect(script).toContain("async function main()");
    expect(script).toMatch(/void main\(\)\.catch/);
    expect(script).not.toMatch(/^(?:const\s+\w+\s*=\s*)?await\s/m);
    expect(script).toContain(
      'from "/tmp/aera-admin/node_modules/payload/dist/index.js"',
    );
    expect(script).not.toContain('from "payload"');
  });

  it("marks the temporary Admin seed entry as an ES module", () => {
    const seedPath = (
      agentControlHarness as typeof agentControlHarness & {
        desktopFleetAdminSeedPath?: (runRoot: string) => string;
      }
    ).desktopFleetAdminSeedPath;

    expect(seedPath).toBeTypeOf("function");
    expect(seedPath!("/tmp/aera-desktop-fleet-e2e-123")).toBe(
      "/tmp/aera-desktop-fleet-e2e-123/seed-desktop-fleet-admin.mts",
    );
  });

  it("starts Payload through the direct Next process owned by the harness", () => {
    const invocation = (
      agentControlHarness as typeof agentControlHarness & {
        desktopFleetAdminServerInvocation?: (
          adminRoot: string,
          payloadBaseURL: string,
        ) => { executable: string; args: string[] };
      }
    ).desktopFleetAdminServerInvocation;

    expect(invocation).toBeTypeOf("function");
    const result = invocation!("/tmp/aera-admin", "http://127.0.0.1:45678");
    expect(result.executable).toBe(process.execPath);
    expect(result.args).toEqual([
      "/tmp/aera-admin/node_modules/next/dist/bin/next",
      "dev",
      "--port",
      "45678",
    ]);
  });

  it("reports only bounded Cloud Admin configuration presence", () => {
    const diagnostics = (
      agentControlHarness as typeof agentControlHarness & {
        desktopFleetAdminEnvironmentDiagnostics?: (env: NodeJS.ProcessEnv) => {
          allRequiredPresent: boolean;
          baseURL: string | null;
          baseURLValid: boolean;
          filesValid: boolean;
          identityValid: boolean;
          scopesValid: boolean;
        };
      }
    ).desktopFleetAdminEnvironmentDiagnostics;

    expect(diagnostics).toBeTypeOf("function");
    expect(
      diagnostics!({
        AGENTERA_CLOUD_ADMIN_BASE_URL: "https://127.0.0.1:1234",
        AGENTERA_CLOUD_ADMIN_CA_FILE: "/tmp/ca.pem",
        AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE: "/tmp/client.pem",
        AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE: "/tmp/client-key.pem",
        AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE: "/tmp/service-key.pem",
        AGENTERA_CLOUD_ADMIN_JWT_ISSUER: "aera-admin",
        AGENTERA_CLOUD_ADMIN_JWT_SUBJECT: "aera-admin-e2e",
        AGENTERA_CLOUD_ADMIN_SCOPES: '["desktop_control:read"]',
      }),
    ).toEqual({
      allRequiredPresent: true,
      baseURL: "https://127.0.0.1:1234",
      baseURLValid: true,
      filesValid: true,
      identityValid: true,
      scopesValid: true,
    });
  });

  it("uses the exact Cloud scopes required by the Desktop Fleet journey", () => {
    const scopes = (
      agentControlHarness as typeof agentControlHarness & {
        desktopFleetAdminScopes?: readonly string[];
      }
    ).desktopFleetAdminScopes;

    expect(scopes).toEqual([
      "users:read",
      "desktop_control:read",
      "desktop_control:command",
    ]);
  });

  it("ignores an in-flight heartbeat until Cloud returns bounded identity", () => {
    const acceptedHeartbeat = (
      desktopFleetHarness as typeof desktopFleetHarness & {
        acceptedDesktopHeartbeat?: (
          requests: desktopFleetHarness.DesktopControlRequestEvidence[],
        ) => { deviceId: string; acceptedAt: string } | null;
      }
    ).acceptedDesktopHeartbeat;

    expect(acceptedHeartbeat).toBeTypeOf("function");
    expect(
      acceptedHeartbeat!([
        {
          method: "POST",
          path: "/api/v1/devices/current/desktop-control/heartbeat",
          body: {},
        },
        {
          method: "POST",
          path: "/api/v1/devices/current/desktop-control/heartbeat",
          body: {},
          responseStatus: 200,
          responseBody: {
            instance_id: "device-1",
            accepted_at: "2026-08-11T00:00:00Z",
          },
        },
      ]),
    ).toEqual({
      deviceId: "device-1",
      acceptedAt: "2026-08-11T00:00:00Z",
    });
  });

  it("requires explicit repository roots", () => {
    expect(() => resolveDesktopFleetRepositories({})).toThrow(/repository/i);
  });

  it("returns only run-owned device and PKI paths", () => {
    expect(desktopFleetOwnedPaths("/tmp/aera-desktop-fleet-e2e-123")).toEqual(
      expect.arrayContaining([
        "/tmp/aera-desktop-fleet-e2e-123/pki",
        "/tmp/aera-desktop-fleet-e2e-123/device-a/electron-user-data",
        "/tmp/aera-desktop-fleet-e2e-123/device-a/hermes-home",
      ]),
    );
  });

  it("rejects cleanup targets outside the run root", () => {
    expect(() =>
      assertOwnedCleanupTarget(
        "/Users/operator",
        "/tmp/aera-desktop-fleet-e2e-123",
      ),
    ).toThrow(/owned|run root/i);
  });

  it("removes the selected run-owned installed Runtime and clears its seed", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "aera-desktop-fleet-harness-test-"),
    );
    const runtimeSeedDirectory = join(root, "runtime-seed");
    const userData = join(root, "device-a", "electron-user-data");
    const installedRuntime = join(userData, "runtime");
    await mkdir(runtimeSeedDirectory, { recursive: true });
    await mkdir(installedRuntime, { recursive: true });
    await writeFile(join(runtimeSeedDirectory, "seed.json"), "seed");
    await writeFile(join(installedRuntime, "current.json"), "installed");

    const harness = {
      root,
      runtimeSeedDirectory,
      deviceRoots: {
        A: { userData, hermesHome: join(root, "device-a", "hermes-home") },
      },
    } as unknown as AgentControlHarness;

    try {
      await removeRunOwnedRuntime(harness, "A");

      await expect(access(installedRuntime)).rejects.toThrow();
      await expect(readdir(runtimeSeedDirectory)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
