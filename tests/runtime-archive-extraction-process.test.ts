import { readFile, stat } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  buildRuntimeArchiveExtractionHelperEnvironment,
  resolveRuntimeArchiveExtractionHelperPath,
  shouldUseIsolatedRuntimeArchiveExtraction,
  extractRuntimeArchiveWithHelper,
  type RuntimeArchiveExtractionHelperExecutor,
} from "../src/main/agentera-runtime-distribution/archive-extraction-process";

it("selects the isolated archive extractor only for packaged Windows Electron", () => {
  expect(
    shouldUseIsolatedRuntimeArchiveExtraction("win32", "41.10.5", false),
  ).toBe(true);
  expect(
    shouldUseIsolatedRuntimeArchiveExtraction("darwin", "41.10.5", false),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveExtraction("win32", undefined, false),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveExtraction("win32", "41.10.5", true),
  ).toBe(false);
  expect(
    shouldUseIsolatedRuntimeArchiveExtraction("win32", "41.10.5", false, false),
  ).toBe(false);
});

it("starts the packaged executable in credential-free Node mode and removes its request", async () => {
  let requestPath = "";
  let executionTimeout: number | undefined;
  const execute = vi.fn<RuntimeArchiveExtractionHelperExecutor>(
    async (executable, arguments_, options) => {
      requestPath = arguments_[1] ?? "";
      executionTimeout = options.timeoutMs;
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      expect(executable).toBe("C:\\Program Files\\Aera\\Aera.exe");
      expect(arguments_[0]).toBe(
        "C:\\Program Files\\Aera\\resources\\runtime-archive-extraction-helper\\runtime-archive-extraction-helper.js",
      );
      expect(request).toEqual({
        schemaVersion: 1,
        archivePath: "C:\\Program Files\\Aera\\resources\\seed.zip",
        destination: "C:\\Users\\tester\\runtime\\staging.zip-extracting",
        hostPlatform: "win32",
      });
      expect(options.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1",
        AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER: "1",
        SystemRoot: "C:\\Windows",
      });
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.windowsHide).toBe(true);
      return { stdout: '{"schemaVersion":1,"ok":true}\n', stderr: "" };
    },
  );

  await expect(
    extractRuntimeArchiveWithHelper(
      {
        archivePath: "C:\\Program Files\\Aera\\resources\\seed.zip",
        destination: "C:\\Users\\tester\\runtime\\staging.zip-extracting",
        hostPlatform: "win32",
      },
      {
        executablePath: "C:\\Program Files\\Aera\\Aera.exe",
        helperPath:
          "C:\\Program Files\\Aera\\resources\\runtime-archive-extraction-helper\\runtime-archive-extraction-helper.js",
        sourceEnvironment: {
          SystemRoot: "C:\\Windows",
          OPENAI_API_KEY: "must-not-cross-process-boundary",
        },
        execute,
      },
    ),
  ).resolves.toBeUndefined();

  expect(execute).toHaveBeenCalledOnce();
  expect(executionTimeout).toBe(8 * 60 * 1000);
  await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("resolves the extraction helper outside app.asar interception", () => {
  expect(
    resolveRuntimeArchiveExtractionHelperPath(
      "C:\\Program Files\\Aera\\resources",
      "win32",
    ),
  ).toBe(
    "C:\\Program Files\\Aera\\resources\\runtime-archive-extraction-helper\\runtime-archive-extraction-helper.js",
  );
});

it("passes only the minimum Windows process environment", () => {
  expect(
    buildRuntimeArchiveExtractionHelperEnvironment({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      NODE_OPTIONS: "--inspect",
      API_KEY: "secret",
    }),
  ).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
    AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER: "1",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
  });
});

it("fails closed when the extraction helper returns an invalid result", async () => {
  const execute = vi.fn<RuntimeArchiveExtractionHelperExecutor>(async () => ({
    stdout: '{"schemaVersion":1,"ok":true,"unexpected":true}\n',
    stderr: "",
  }));

  await expect(
    extractRuntimeArchiveWithHelper(
      {
        archivePath: "C:\\runtime\\seed.zip",
        destination: "C:\\runtime\\staging",
        hostPlatform: "win32",
      },
      { executablePath: "Aera.exe", helperPath: "helper.js", execute },
    ),
  ).rejects.toThrow(/invalid result/i);
});

it("returns a bounded timeout when the child ignores AbortSignal", async () => {
  const startedAt = Date.now();
  const execute = vi.fn<RuntimeArchiveExtractionHelperExecutor>(
    async () => await new Promise<never>(() => undefined),
  );

  await expect(
    extractRuntimeArchiveWithHelper(
      {
        archivePath: "C:\\runtime\\seed.zip",
        destination: "C:\\runtime\\staging",
        hostPlatform: "win32",
      },
      {
        executablePath: "Aera.exe",
        helperPath: "helper.js",
        timeoutMs: 20,
        execute,
      },
    ),
  ).rejects.toThrow(/timed out/i);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

it("cancels the helper and removes its request when the caller aborts", async () => {
  const controller = new AbortController();
  let requestPath = "";
  let helperSignal: AbortSignal | undefined;
  const execute = vi.fn<RuntimeArchiveExtractionHelperExecutor>(
    async (_executable, arguments_, options) => {
      requestPath = arguments_[1] ?? "";
      helperSignal = options.signal;
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  );
  const pending = extractRuntimeArchiveWithHelper(
    {
      archivePath: "C:\\runtime\\seed.zip",
      destination: "C:\\runtime\\staging",
      hostPlatform: "win32",
    },
    {
      executablePath: "Aera.exe",
      helperPath: "helper.js",
      signal: controller.signal,
      execute,
    },
  );
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(helperSignal?.aborted).toBe(true);
  await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
});
