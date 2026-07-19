import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const persistedDesktopConfig = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
const systemLocale = vi.hoisted(() => ({ value: "en-US" }));

vi.mock("electron", () => ({
  app: {
    getLocale: () => systemLocale.value,
  },
}));

vi.mock("../src/main/config", () => ({
  readDesktopConfig: () => ({ ...persistedDesktopConfig.value }),
  writeDesktopConfig: (data: Record<string, unknown>) => {
    persistedDesktopConfig.value = { ...data };
  },
}));

let testHome: string;

async function loadLocaleModule(): Promise<
  typeof import("../src/main/locale")
> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", testHome);
  return await import("../src/main/locale");
}

describe("app locale persistence", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "hermes-locale-"));
    persistedDesktopConfig.value = {};
    systemLocale.value = "en-US";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  it("reloads the saved locale after the main process restarts", async () => {
    const firstRun = await loadLocaleModule();

    expect(firstRun.setAppLocale("es")).toBe("es");

    const secondRun = await loadLocaleModule();

    expect(secondRun.getAppLocale()).toBe("es");
  }, 30000);

  it("uses the operating-system language until the user saves a preference", async () => {
    systemLocale.value = "zh-CN";

    const locale = await loadLocaleModule();

    expect(locale.getAppLocale()).toBe("zh-CN");
  });
});
