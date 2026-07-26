import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testHome: string;

async function loadConfigModule(): Promise<
  typeof import("../src/main/config")
> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", testHome);
  return await import("../src/main/config");
}

function readEnvFile(): string {
  return readFileSync(join(testHome, ".env"), "utf-8");
}

describe("environment variable write validation", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "hermes-env-validation-"));
    vi.stubEnv("API_SERVER_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  it("accepts standard environment variable names and single-line values", async () => {
    const { readEnv, setEnvValue } = await loadConfigModule();

    setEnvValue("OPENAI_API_KEY", "sk-valid");
    setEnvValue("_CUSTOM_TOKEN_2", "token=value=with=equals");

    expect(readEnv()).toEqual({
      OPENAI_API_KEY: "sk-valid",
      _CUSTOM_TOKEN_2: "token=value=with=equals",
    });
    expect(readEnvFile()).toContain("OPENAI_API_KEY=sk-valid");
  });

  it("rejects malformed environment variable names", async () => {
    const { setEnvValue } = await loadConfigModule();

    expect(() => setEnvValue("1TOKEN", "value")).toThrow(
      /Invalid environment variable name/,
    );
    expect(() => setEnvValue("BAD-KEY", "value")).toThrow(
      /Invalid environment variable name/,
    );
    expect(() => setEnvValue("KEY\nINJECTED", "value")).toThrow(
      /Invalid environment variable name/,
    );
    expect(existsSync(join(testHome, ".env"))).toBe(false);
  });

  it("rejects newline and NUL characters before rewriting .env", async () => {
    const { setEnvValue } = await loadConfigModule();

    setEnvValue("SAFE_KEY", "original");

    expect(() => setEnvValue("SAFE_KEY", "next\nINJECTED=value")).toThrow(
      /single-line/,
    );
    expect(() => setEnvValue("SAFE_KEY", "next\rINJECTED=value")).toThrow(
      /single-line/,
    );
    expect(() => setEnvValue("SAFE_KEY", "next\0INJECTED=value")).toThrow(
      /single-line/,
    );

    expect(readEnvFile()).toBe("SAFE_KEY=original\n");
  });

  it("keeps empty values in the read-back dict (valid POSIX env var)", async () => {
    const { readEnv, setEnvValue } = await loadConfigModule();

    setEnvValue("EMPTY_FLAG", "");
    setEnvValue("WITH_VALUE", "present");

    const env = readEnv();
    expect(env.EMPTY_FLAG).toBe("");
    expect(env.WITH_VALUE).toBe("present");
    expect(readEnvFile()).toContain("EMPTY_FLAG=\n");
  });

  it.skipIf(process.platform === "win32")(
    "keeps new and rewritten credential files private to the current user",
    async () => {
      const { setEnvValue } = await loadConfigModule();
      const envFile = join(testHome, ".env");

      setEnvValue("API_SERVER_KEY", "internal-token");
      expect(statSync(envFile).mode & 0o777).toBe(0o600);

      chmodSync(envFile, 0o644);
      setEnvValue("OPENAI_API_KEY", "provider-token");
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    },
  );

  it("creates a strong local gateway credential in the active named profile", async () => {
    writeFileSync(join(testHome, "active_profile"), "work\n", "utf-8");
    const { ensureLocalApiServerKey, readEnv } = await loadConfigModule();

    const result = ensureLocalApiServerKey();

    expect(result.generated).toBe(true);
    expect(result.key).toMatch(/^[a-f0-9]{64}$/);
    expect(readEnv("work").API_SERVER_KEY).toBe(result.key);
    expect(existsSync(join(testHome, ".env"))).toBe(false);
  });

  it("reuses the active named profile credential instead of the default profile credential", async () => {
    writeFileSync(join(testHome, "active_profile"), "work\n", "utf-8");
    const { ensureLocalApiServerKey, setEnvValue } = await loadConfigModule();
    const defaultKey = "default-profile-internal-token";
    const namedKey = "named-profile-internal-token";
    setEnvValue("API_SERVER_KEY", defaultKey);
    setEnvValue("API_SERVER_KEY", namedKey, "work");

    const result = ensureLocalApiServerKey();

    expect(result).toEqual({ generated: false, key: namedKey });
  });

  it("never overwrites a command-backed secrets provider when its gateway credential is missing", async () => {
    const profileHome = join(testHome, "profiles", "vault");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(
      join(profileHome, "config.yaml"),
      `secrets:
  provider: command
  command: "printf ''"
`,
      "utf-8",
    );
    const { ensureLocalApiServerKey } = await loadConfigModule();

    expect(() => ensureLocalApiServerKey("vault")).toThrow(
      /secrets provider must supply/i,
    );
    expect(existsSync(join(profileHome, ".env"))).toBe(false);
    expect(existsSync(join(testHome, ".env"))).toBe(false);
  });
});
