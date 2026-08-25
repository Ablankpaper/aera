import { readFile, stat } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  buildRuntimeArchiveValidationHelperEnvironment,
  resolveRuntimeArchiveValidationHelperPath,
  shouldUseIsolatedRuntimeArchiveValidation,
  verifyRuntimeArchiveWithHelper,
  type RuntimeArchiveValidationHelperExecutor,
} from "../src/main/agentera-runtime-distribution/archive-validation-process";
import { createFixtureManifest } from "./fixtures/runtime-distribution/fixture";

const manifest = createFixtureManifest({
  platform: "windows",
  arch: "x64",
  archive_name: "agentera-runtime-test-windows-x64.zip",
  files: [],
});

it("selects the isolated archive validator only for the packaged Windows parent", () => {
  expect(
    shouldUseIsolatedRuntimeArchiveValidation("win32", "41.10.5", false),
  ).toBe(true);
  expect(
    shouldUseIsolatedRuntimeArchiveValidation("win32", undefined, false),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveValidation("win32", "41.10.5", true),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveValidation("win32", "41.10.5", false, false),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveValidation("darwin", "41.10.5", false),
  ).toBe(false);
});

it("starts the packaged executable in credential-free Node mode and removes its request", async () => {
  let requestPath = "";
  const execute = vi.fn<RuntimeArchiveValidationHelperExecutor>(
    async (executable, arguments_, options) => {
      requestPath = arguments_[1] ?? "";
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      expect(executable).toBe("C:\\Program Files\\Aera\\Aera.exe");
      expect(arguments_[0]).toBe(
        "C:\\Program Files\\Aera\\resources\\runtime-archive-validation-helper\\runtime-archive-validation-helper.js",
      );
      expect(request).toEqual({
        schemaVersion: 1,
        archivePath: "C:\\Program Files\\Aera\\resources\\seed.zip",
        manifest,
        maxExtractedBytes: 4096,
        hostPlatform: "win32",
      });
      expect(options.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1",
        AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER: "1",
        SystemRoot: "C:\\Windows",
      });
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.windowsHide).toBe(true);
      return { stdout: '{"schemaVersion":1,"ok":true}\n', stderr: "" };
    },
  );

  await expect(
    verifyRuntimeArchiveWithHelper(
      {
        archivePath: "C:\\Program Files\\Aera\\resources\\seed.zip",
        manifest,
        maxExtractedBytes: 4096,
        hostPlatform: "win32",
      },
      {
        executablePath: "C:\\Program Files\\Aera\\Aera.exe",
        helperPath:
          "C:\\Program Files\\Aera\\resources\\runtime-archive-validation-helper\\runtime-archive-validation-helper.js",
        sourceEnvironment: {
          SystemRoot: "C:\\Windows",
          OPENAI_API_KEY: "must-not-cross-process-boundary",
        },
        execute,
      },
    ),
  ).resolves.toBeUndefined();

  expect(execute).toHaveBeenCalledOnce();
  await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("resolves the helper outside app.asar interception", () => {
  expect(
    resolveRuntimeArchiveValidationHelperPath(
      "C:\\Program Files\\Aera\\resources",
      "win32",
    ),
  ).toBe(
    "C:\\Program Files\\Aera\\resources\\runtime-archive-validation-helper\\runtime-archive-validation-helper.js",
  );
});

it("passes only the minimum Windows process environment", () => {
  expect(
    buildRuntimeArchiveValidationHelperEnvironment({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      NODE_OPTIONS: "--inspect",
      API_KEY: "secret",
    }),
  ).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
    AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER: "1",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
  });
});

it("fails closed when the archive helper returns an invalid result", async () => {
  const execute = vi.fn<RuntimeArchiveValidationHelperExecutor>(async () => ({
    stdout: '{"schemaVersion":1,"ok":true,"unexpected":true}\n',
    stderr: "",
  }));

  await expect(
    verifyRuntimeArchiveWithHelper(
      {
        archivePath: "C:\\runtime\\seed.zip",
        manifest,
        maxExtractedBytes: 4096,
        hostPlatform: "win32",
      },
      { executablePath: "Aera.exe", helperPath: "helper.js", execute },
    ),
  ).rejects.toThrow(/invalid result/i);
});
