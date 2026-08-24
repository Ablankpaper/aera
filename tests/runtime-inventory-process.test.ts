import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildRuntimeInventoryHelperEnvironment,
  resolveRuntimeInventoryHelperPath,
  shouldUseIsolatedRuntimeInventory,
  verifyRuntimeInventoryWithHelper,
  type RuntimeInventoryHelperExecutor,
} from "../src/main/agentera-runtime-distribution/inventory-process";
import { createFixtureManifest } from "./fixtures/runtime-distribution/fixture";

const manifest = createFixtureManifest({
  platform: "windows",
  arch: "x64",
  archive_name: "agentera-runtime-test-windows-x64.zip",
  files: [],
});

describe("isolated Runtime inventory verification", () => {
  it("selects Node mode only for the Windows Electron parent process", () => {
    expect(shouldUseIsolatedRuntimeInventory("win32", "41.10.5", false)).toBe(
      true,
    );
    expect(shouldUseIsolatedRuntimeInventory("win32", undefined, false)).toBe(
      false,
    );
    expect(shouldUseIsolatedRuntimeInventory("darwin", "41.10.5", false)).toBe(
      false,
    );
    expect(shouldUseIsolatedRuntimeInventory("win32", "41.10.5", true)).toBe(
      false,
    );
    expect(
      shouldUseIsolatedRuntimeInventory("win32", "41.10.5", false, false),
    ).toBe(false);
  });

  it("starts the packaged executable in credential-free Node mode and removes its request", async () => {
    let requestPath = "";
    const execute = vi.fn<RuntimeInventoryHelperExecutor>(
      async (executable, arguments_, options) => {
        requestPath = arguments_[1] ?? "";
        const request = JSON.parse(await readFile(requestPath, "utf8"));
        expect(executable).toBe("C:\\Program Files\\Aera\\Aera.exe");
        expect(arguments_[0]).toBe(
          "C:\\Program Files\\Aera\\resources\\runtime-inventory-helper.js",
        );
        expect(request).toEqual({
          schemaVersion: 1,
          destination: "C:\\Users\\tester\\runtime\\staging",
          manifest,
          maxExtractedBytes: 4096,
          hostPlatform: "win32",
        });
        expect(options.env).toMatchObject({
          ELECTRON_RUN_AS_NODE: "1",
          AGENTERA_RUNTIME_INVENTORY_HELPER: "1",
          SystemRoot: "C:\\Windows",
        });
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
        expect(options.windowsHide).toBe(true);
        return {
          stdout: `${JSON.stringify({
            schemaVersion: 1,
            ok: true,
            fileCount: 0,
            extractedBytes: 0,
          })}\n`,
          stderr: "",
        };
      },
    );

    await expect(
      verifyRuntimeInventoryWithHelper(
        {
          destination: "C:\\Users\\tester\\runtime\\staging",
          manifest,
          maxExtractedBytes: 4096,
          hostPlatform: "win32",
        },
        {
          executablePath: "C:\\Program Files\\Aera\\Aera.exe",
          helperPath:
            "C:\\Program Files\\Aera\\resources\\runtime-inventory-helper.js",
          sourceEnvironment: {
            SystemRoot: "C:\\Windows",
            OPENAI_API_KEY: "must-not-cross-process-boundary",
          },
          execute,
        },
      ),
    ).resolves.toEqual({ fileCount: 0, extractedBytes: 0 });

    expect(execute).toHaveBeenCalledOnce();
    await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves the packaged helper outside app.asar interception", async () => {
    expect(
      resolveRuntimeInventoryHelperPath(
        "C:\\Program Files\\Aera\\resources",
        "win32",
      ),
    ).toBe(
      "C:\\Program Files\\Aera\\resources\\runtime-inventory-helper\\runtime-inventory-helper.js",
    );
  });

  it("passes only the minimum Windows process environment", () => {
    expect(
      buildRuntimeInventoryHelperEnvironment({
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE",
        NODE_OPTIONS: "--inspect",
        API_KEY: "secret",
      }),
    ).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      AGENTERA_RUNTIME_INVENTORY_HELPER: "1",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    });
  });

  it("forwards the bounded inventory diagnostic output without forwarding credentials", () => {
    expect(
      buildRuntimeInventoryHelperEnvironment({
        SystemRoot: "C:\\Windows",
        AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT:
          "C:\\Temp\\runtime-inventory-events.jsonl",
        OPENAI_API_KEY: "must-not-cross-process-boundary",
      }),
    ).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      AGENTERA_RUNTIME_INVENTORY_HELPER: "1",
      SystemRoot: "C:\\Windows",
      AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT:
        "C:\\Temp\\runtime-inventory-events.jsonl",
    });
  });

  it("records the parent spawn and result boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "aera-inventory-parent-"));
    const diagnosticPath = join(root, "events.jsonl");
    try {
      await expect(
        verifyRuntimeInventoryWithHelper(
          {
            destination: "C:\\runtime\\staging",
            manifest,
            maxExtractedBytes: 4096,
            hostPlatform: "win32",
          },
          {
            executablePath: "Aera.exe",
            helperPath: "runtime-inventory-helper.js",
            sourceEnvironment: {
              AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT: diagnosticPath,
            },
            execute: async () => ({
              stdout: `${JSON.stringify({
                schemaVersion: 1,
                ok: true,
                fileCount: 0,
                extractedBytes: 0,
              })}\n`,
              stderr: "",
            }),
          },
        ),
      ).resolves.toEqual({ fileCount: 0, extractedBytes: 0 });

      const events = (await readFile(diagnosticPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string })
        .map(({ event }) => event);
      expect(events).toEqual([
        "helper-spawn-start",
        "helper-process-complete",
        "helper-result-parsed",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the helper returns an invalid result", async () => {
    const execute = vi.fn<RuntimeInventoryHelperExecutor>(async () => ({
      stdout: '{"schemaVersion":1,"ok":true,"fileCount":"0"}\n',
      stderr: "",
    }));

    await expect(
      verifyRuntimeInventoryWithHelper(
        {
          destination: "C:\\runtime\\staging",
          manifest,
          maxExtractedBytes: 4096,
          hostPlatform: "win32",
        },
        {
          executablePath: "Aera.exe",
          helperPath: "runtime-inventory-helper.js",
          execute,
        },
      ),
    ).rejects.toThrow(/invalid result/i);
  });

  it("forwards cancellation to the helper and still removes its request", async () => {
    let requestPath = "";
    const controller = new AbortController();
    const execute = vi.fn<RuntimeInventoryHelperExecutor>(
      async (_executable, arguments_, options) => {
        requestPath = arguments_[1] ?? "";
        expect(options.signal).toBe(controller.signal);
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    );

    await expect(
      verifyRuntimeInventoryWithHelper(
        {
          destination: "C:\\runtime\\staging",
          manifest,
          maxExtractedBytes: 4096,
          hostPlatform: "win32",
        },
        {
          executablePath: "Aera.exe",
          helperPath: "runtime-inventory-helper.js",
          signal: controller.signal,
          execute,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a request or spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn<RuntimeInventoryHelperExecutor>();

    await expect(
      verifyRuntimeInventoryWithHelper(
        {
          destination: "C:\\runtime\\staging",
          manifest,
          maxExtractedBytes: 4096,
          hostPlatform: "win32",
        },
        {
          executablePath: "Aera.exe",
          helperPath: "runtime-inventory-helper.js",
          signal: controller.signal,
          execute,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });
});
