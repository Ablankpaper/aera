import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyLiveGatewayProcessInspectionError,
  inspectActiveGatewayProfile,
  inspectGatewayPidFile,
  inspectInstalledRuntimeContract,
  inspectLiveGatewayProcess,
  inspectLiveGatewayEndpoint,
  parseWindowsProcessIdentityProbe,
  probeRuntimeCapabilities,
  readRedactedGatewayLogTail,
} from "./agentera-runtime-contract-evidence";

const SOURCE_COMMIT = "8".repeat(40);

describe("packaged Runtime contract evidence", () => {
  it("binds the current pointer to the installed manifest and executable hashes", async () => {
    const userData = await mkdtemp(join(tmpdir(), "aera-runtime-contract-"));
    const versionDirectory = "runtime-test-version";
    const versionRoot = join(userData, "runtime", "versions", versionDirectory);
    const pythonDirectory = join(versionRoot, "python", "bin");
    const hermesDirectory = join(
      versionRoot,
      "python",
      "lib",
      "python3.11",
      "site-packages",
      "hermes_cli",
    );
    await mkdir(pythonDirectory, { recursive: true });
    await mkdir(hermesDirectory, { recursive: true });

    const pythonBytes = Buffer.from("packaged-python-evidence\n");
    const hermesBytes = Buffer.from("packaged-hermes-evidence\n");
    await writeFile(join(pythonDirectory, "python3.11"), pythonBytes);
    await symlink("python3.11", join(pythonDirectory, "python3"));
    await writeFile(join(hermesDirectory, "main.py"), hermesBytes);

    const pythonSha256 = createHash("sha256").update(pythonBytes).digest("hex");
    const hermesSha256 = createHash("sha256").update(hermesBytes).digest("hex");
    const manifest = {
      runtime_version: "0.20.0-agentera.5",
      source_commit: SOURCE_COMMIT,
      files: [
        {
          path: "python/bin/python3.11",
          kind: "file",
          sha256: pythonSha256,
        },
        {
          path: "python/lib/python3.11/site-packages/hermes_cli/main.py",
          kind: "file",
          sha256: hermesSha256,
        },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestSha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    await writeFile(
      join(versionRoot, ".agentera-runtime-manifest.json"),
      manifestBytes,
    );
    await mkdir(join(userData, "runtime"), { recursive: true });
    await writeFile(
      join(userData, "runtime", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        runtimeVersion: manifest.runtime_version,
        sourceCommit: SOURCE_COMMIT,
        versionDirectory,
        manifestSha256,
        installedAt: "2026-08-23T00:00:00.000Z",
      }),
    );

    await expect(
      inspectInstalledRuntimeContract(userData, { platform: "darwin" }),
    ).resolves.toEqual(
      expect.objectContaining({
        runtimeVersion: "0.20.0-agentera.5",
        sourceCommit: SOURCE_COMMIT,
        versionDirectory,
        manifestSha256,
        manifestSourceCommit: SOURCE_COMMIT,
        pythonExecutable: expect.objectContaining({
          sha256: pythonSha256,
          manifestSha256: pythonSha256,
        }),
        hermesEntrypoint: expect.objectContaining({
          sha256: hermesSha256,
          manifestSha256: hermesSha256,
        }),
      }),
    );
  });

  it("binds a Windows current pointer to the packaged Python and Hermes files", async () => {
    const userData = await mkdtemp(
      join(tmpdir(), "aera-runtime-windows-contract-"),
    );
    const versionDirectory = "runtime-test-windows-version";
    const versionRoot = join(userData, "runtime", "versions", versionDirectory);
    const pythonDirectory = join(versionRoot, "python");
    const hermesDirectory = join(
      pythonDirectory,
      "Lib",
      "site-packages",
      "hermes_cli",
    );
    await mkdir(hermesDirectory, { recursive: true });

    const pythonBytes = Buffer.from("packaged-windows-python-evidence\n");
    const hermesBytes = Buffer.from("packaged-windows-hermes-evidence\n");
    await writeFile(join(pythonDirectory, "python.exe"), pythonBytes);
    await writeFile(join(hermesDirectory, "main.py"), hermesBytes);

    const pythonSha256 = createHash("sha256").update(pythonBytes).digest("hex");
    const hermesSha256 = createHash("sha256").update(hermesBytes).digest("hex");
    const manifest = {
      runtime_version: "0.20.0-agentera.5",
      source_commit: SOURCE_COMMIT,
      files: [
        {
          path: "python/python.exe",
          kind: "file",
          sha256: pythonSha256,
        },
        {
          path: "python/Lib/site-packages/hermes_cli/main.py",
          kind: "file",
          sha256: hermesSha256,
        },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(
      join(versionRoot, ".agentera-runtime-manifest.json"),
      manifestBytes,
    );
    await mkdir(join(userData, "runtime"), { recursive: true });
    await writeFile(
      join(userData, "runtime", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        runtimeVersion: manifest.runtime_version,
        sourceCommit: SOURCE_COMMIT,
        versionDirectory,
        manifestSha256: createHash("sha256")
          .update(manifestBytes)
          .digest("hex"),
        installedAt: "2026-08-23T00:00:00.000Z",
      }),
    );
    const realVersionRoot = await realpath(versionRoot);

    await expect(
      inspectInstalledRuntimeContract(userData, { platform: "win32" }),
    ).resolves.toEqual(
      expect.objectContaining({
        pythonExecutable: expect.objectContaining({
          path: join(realVersionRoot, "python", "python.exe"),
          sha256: pythonSha256,
        }),
        hermesEntrypoint: expect.objectContaining({
          path: join(
            realVersionRoot,
            "python",
            "Lib",
            "site-packages",
            "hermes_cli",
            "main.py",
          ),
          sha256: hermesSha256,
        }),
      }),
    );
  });

  it("resolves the gateway PID location from the one active named Profile", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "aera-runtime-profile-"));
    const agentProfile = join(hermesHome, "profiles", "research-agent");
    await mkdir(agentProfile, { recursive: true });

    await expect(
      inspectActiveGatewayProfile([
        {
          id: "default",
          path: hermesHome,
          isActive: false,
          isDefault: true,
        },
        {
          id: "research-agent",
          path: agentProfile,
          isActive: true,
          isDefault: false,
        },
      ]),
    ).resolves.toEqual({
      profileId: "research-agent",
      profilePath: agentProfile,
      pidFile: join(agentProfile, "gateway.pid"),
    });
  });

  it("binds capability probing to the live Gateway process listening socket", async () => {
    await expect(
      inspectLiveGatewayEndpoint(4242, async (pid) => {
        expect(pid).toBe(4242);
        return [
          { address: "127.0.0.1", port: 18643 },
          { address: "::1", port: 18643 },
        ];
      }),
    ).resolves.toEqual({
      address: "127.0.0.1",
      port: 18643,
      origin: "http://127.0.0.1:18643",
    });
  });

  it("proves the live gateway command uses the installed Python executable", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "aera-runtime-process-"));
    await writeFile(join(hermesHome, "gateway.pid"), '{"pid":4242}\n');
    const pythonExecutable = "/runtime/version/python/bin/python3";

    await expect(
      inspectLiveGatewayProcess(hermesHome, pythonExecutable, async (pid) => {
        expect(pid).toBe(4242);
        return {
          executable: pythonExecutable,
          command: `${pythonExecutable} -m hermes_cli.main gateway`,
        };
      }),
    ).resolves.toMatchObject({
      pid: 4242,
      executable: pythonExecutable,
      command: `${pythonExecutable} -m hermes_cli.main gateway`,
    });
  });

  it("reports bounded Gateway PID states and stable process failure classes", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "aera-runtime-pid-state-"));

    await expect(inspectGatewayPidFile(hermesHome)).resolves.toEqual({
      status: "missing",
      pid: null,
    });

    await writeFile(join(hermesHome, "gateway.pid"), "not-a-pid\n");
    await expect(inspectGatewayPidFile(hermesHome)).resolves.toEqual({
      status: "invalid",
      pid: null,
    });

    await writeFile(join(hermesHome, "gateway.pid"), '{"pid":4242}\n');
    await expect(inspectGatewayPidFile(hermesHome)).resolves.toEqual({
      status: "valid",
      pid: 4242,
    });

    expect(
      classifyLiveGatewayProcessInspectionError(
        new Error("Live Runtime process identity is unavailable"),
      ),
    ).toBe("process_identity_unavailable");
    expect(
      classifyLiveGatewayProcessInspectionError(
        new Error(
          "Live Gateway executable differs from installed Runtime Python",
        ),
      ),
    ).toBe("executable_mismatch");
    expect(
      classifyLiveGatewayProcessInspectionError(new Error("private detail")),
    ).toBe("unexpected");
  });

  it("separates a missing Windows process from a failed CIM query", () => {
    expect(() =>
      parseWindowsProcessIdentityProbe({
        status: 0,
        stdout: '{"state":"missing"}',
      }),
    ).toThrow("Live Runtime process is unavailable");
    expect(
      classifyLiveGatewayProcessInspectionError(
        new Error("Live Runtime process is unavailable"),
      ),
    ).toBe("process_missing");

    expect(() =>
      parseWindowsProcessIdentityProbe({
        status: 0,
        stdout: '{"state":"query_failed"}',
      }),
    ).toThrow("Windows Runtime process query failed");
    expect(
      classifyLiveGatewayProcessInspectionError(
        new Error("Windows Runtime process query failed"),
      ),
    ).toBe("process_query_failed");

    expect(
      parseWindowsProcessIdentityProbe({
        status: 0,
        stdout:
          '{"state":"ok","executable":"C:\\\\runtime\\\\python.exe","command":"C:\\\\runtime\\\\python.exe -m hermes_cli.main gateway"}',
      }),
    ).toEqual({
      executable: "C:\\runtime\\python.exe",
      command: "C:\\runtime\\python.exe -m hermes_cli.main gateway",
    });
  });

  it("keeps only a bounded redacted Gateway stderr tail", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "aera-runtime-log-tail-"));
    const logPath = join(hermesHome, "gateway-stderr.log");
    const privatePath = "C:\\Users\\alice\\private\\runtime\\main.py";
    const secret = "sk-private-secret-value";
    const apiServerKey = "plain-private-runtime-token";
    await writeFile(
      logPath,
      `${"old-line ".repeat(700)}\nFile "${privatePath}"\nAuthorization: Bearer ${secret}\nAPI_SERVER_KEY=${apiServerKey}\nModuleNotFoundError: No module named gateway\n`,
    );

    const tail = await readRedactedGatewayLogTail(logPath, [hermesHome]);

    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(tail).toContain("ModuleNotFoundError");
    expect(tail).not.toContain(privatePath);
    expect(tail).not.toContain(hermesHome);
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain(apiServerKey);
    expect(tail).toContain("<path>");
    expect(tail).toContain("<redacted>");
  });

  it("accepts the canonical Python target when the locked executable is a symlink", async () => {
    const hermesHome = await mkdtemp(
      join(tmpdir(), "aera-runtime-process-link-"),
    );
    const runtimeBin = join(hermesHome, "runtime", "python", "bin");
    await mkdir(runtimeBin, { recursive: true });
    const canonicalPython = join(runtimeBin, "python3.11");
    const lockedPython = join(runtimeBin, "python3");
    await writeFile(canonicalPython, "runtime-python\n");
    await symlink("python3.11", lockedPython);
    await writeFile(join(hermesHome, "gateway.pid"), "4242\n");

    await expect(
      inspectLiveGatewayProcess(hermesHome, lockedPython, async () => ({
        executable: canonicalPython,
        command: `${canonicalPython} -m hermes_cli.main gateway`,
      })),
    ).resolves.toMatchObject({
      pid: 4242,
      executable: canonicalPython,
      command: `${canonicalPython} -m hermes_cli.main gateway`,
    });
  });

  it("rejects a current pointer whose manifest hash does not match installed bytes", async () => {
    const userData = await mkdtemp(join(tmpdir(), "aera-runtime-pointer-"));
    const versionDirectory = "runtime-test-version";
    const versionRoot = join(userData, "runtime", "versions", versionDirectory);
    await mkdir(join(versionRoot, "python", "bin"), { recursive: true });
    await mkdir(
      join(
        versionRoot,
        "python",
        "lib",
        "python3.11",
        "site-packages",
        "hermes_cli",
      ),
      { recursive: true },
    );
    await writeFile(join(versionRoot, ".agentera-runtime-manifest.json"), "{}");
    await writeFile(
      join(userData, "runtime", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        runtimeVersion: "0.20.0-agentera.5",
        sourceCommit: SOURCE_COMMIT,
        versionDirectory,
        manifestSha256: "f".repeat(64),
        installedAt: "2026-08-23T00:00:00.000Z",
      }),
    );

    await expect(inspectInstalledRuntimeContract(userData)).rejects.toThrow(
      "manifest hash",
    );
  });

  it("requires both request-scoped Runtime capabilities from the real endpoint shape", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          features: {
            request_tool_policy: true,
            request_model_route: true,
          },
          endpoints: {
            chat_completions: { path: "/v1/chat/completions" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      probeRuntimeCapabilities("http://127.0.0.1:18642", "synthetic", fetcher),
    ).resolves.toMatchObject({
      features: {
        request_tool_policy: true,
        request_model_route: true,
      },
    });
  });
});
