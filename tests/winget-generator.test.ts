import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "fs";
import { tmpdir } from "os";
// @ts-expect-error - .mjs has no type declarations; we test it as JS.
import { generateWingetManifests } from "../scripts/generate-winget-manifests.mjs";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "winget-test-"));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function setupTemplates(rootDir: string): void {
  const buildDir = join(rootDir, "build", "winget");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(
    join(buildDir, "Installer.template.yaml"),
    "Version: __VERSION__\nUrl: __INSTALLER_URL__\nSha: __INSTALLER_SHA256__\nDate: __RELEASE_DATE__\n",
  );
  writeFileSync(
    join(buildDir, "Locale.en-US.template.yaml"),
    "Version: __VERSION__\nNotes: __RELEASE_NOTES_URL__\n",
  );
  writeFileSync(
    join(buildDir, "Version.template.yaml"),
    "Version: __VERSION__\n",
  );
}

describe("generateWingetManifests", () => {
  it("keeps usable replacement tokens in the checked-in templates", () => {
    const templateDir = join(process.cwd(), "build", "winget");
    const installer = readFileSync(
      join(templateDir, "Installer.template.yaml"),
      "utf-8",
    );
    const locale = readFileSync(
      join(templateDir, "Locale.en-US.template.yaml"),
      "utf-8",
    );

    expect(installer).toContain("__VERSION__");
    expect(installer).toContain("__INSTALLER_URL__");
    expect(installer).toContain("__INSTALLER_SHA256__");
    expect(locale).toContain("__RELEASE_NOTES_URL__");
  });

  it("produces three YAML files under the winget-pkgs directory layout", () => {
    setupTemplates(TEST_DIR);
    const distDir = join(TEST_DIR, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "Aera-9.9.9-setup.exe"),
      "fake-installer-bytes",
    );

    generateWingetManifests({
      rootDir: TEST_DIR,
      version: "9.9.9",
      publishOwner: "bignormal",
    });

    const outDir = join(
      distDir,
      "winget",
      "manifests",
      "b",
      "Bignormal",
      "AgentEraStudio",
      "9.9.9",
    );
    expect(
      existsSync(join(outDir, "Bignormal.AgentEraStudio.installer.yaml")),
    ).toBe(true);
    expect(
      existsSync(join(outDir, "Bignormal.AgentEraStudio.locale.en-US.yaml")),
    ).toBe(true);
    expect(existsSync(join(outDir, "Bignormal.AgentEraStudio.yaml"))).toBe(
      true,
    );
  });

  it("replaces all placeholders in the installer manifest", () => {
    setupTemplates(TEST_DIR);
    const distDir = join(TEST_DIR, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "Aera-9.9.9-setup.exe"),
      "fake-installer-bytes",
    );

    generateWingetManifests({
      rootDir: TEST_DIR,
      version: "9.9.9",
      publishOwner: "bignormal",
    });

    const outFile = join(
      distDir,
      "winget",
      "manifests",
      "b",
      "Bignormal",
      "AgentEraStudio",
      "9.9.9",
      "Bignormal.AgentEraStudio.installer.yaml",
    );
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("Version: 9.9.9");
    expect(content).toContain(
      "Url: https://github.com/Ablankpaper/aera/releases/download/v9.9.9/Aera-9.9.9-setup.exe",
    );
    expect(content).toMatch(/Sha: [A-F0-9]{64}/);
    expect(content).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    expect(content).not.toContain("__");
  });

  it("replaces ReleaseNotesUrl in the locale manifest", () => {
    setupTemplates(TEST_DIR);
    const distDir = join(TEST_DIR, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "Aera-9.9.9-setup.exe"),
      "fake-installer-bytes",
    );

    generateWingetManifests({
      rootDir: TEST_DIR,
      version: "9.9.9",
      publishOwner: "bignormal",
    });

    const outFile = join(
      distDir,
      "winget",
      "manifests",
      "b",
      "Bignormal",
      "AgentEraStudio",
      "9.9.9",
      "Bignormal.AgentEraStudio.locale.en-US.yaml",
    );
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain(
      "Notes: https://github.com/Ablankpaper/aera/releases/tag/v9.9.9",
    );
    expect(content).not.toContain("__");
  });

  it("throws a clear error when the installer .exe is missing", () => {
    setupTemplates(TEST_DIR);
    mkdirSync(join(TEST_DIR, "dist"), { recursive: true });

    expect(() =>
      generateWingetManifests({
        rootDir: TEST_DIR,
        version: "9.9.9",
        publishOwner: "bignormal",
      }),
    ).toThrow(/installer not found/i);
  });

  it("throws a clear error when the templates directory is missing", () => {
    // Do NOT call setupTemplates — the templates directory should not exist.
    const distDir = join(TEST_DIR, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "Aera-9.9.9-setup.exe"),
      "fake-installer-bytes",
    );

    expect(() =>
      generateWingetManifests({
        rootDir: TEST_DIR,
        version: "9.9.9",
        publishOwner: "bignormal",
      }),
    ).toThrow(/templates not found/i);
  });
});
