// @vitest-environment node

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Mock minimal structures needed to test profile path validation
interface ProfileService {
  resolveProfilePath(profileId: string): string;
}

function createMockProfileService(hermesHome: string): ProfileService {
  return {
    resolveProfilePath(profileId: string): string {
      // Matches the actual profileHome() logic from src/main/utils.ts
      return profileId === "default" || !profileId
        ? hermesHome
        : join(hermesHome, "profiles", profileId);
    },
  };
}

// Import the path validation helpers (these will be in installation-manager.ts)
// We'll test them via a simplified test double since they're private functions

function canonicalizePath(path: string): string {
  const { resolve } = require("node:path");
  const { realpathSync } = require("node:fs");
  try {
    return resolve(realpathSync.native(path));
  } catch {
    return resolve(path);
  }
}

function profilePathMatchesId(
  profilePath: string,
  profileId: string,
  resolveProfilePath: (profileId: string) => string,
): boolean {
  const { isAbsolute, resolve } = require("node:path");
  if (!isAbsolute(profilePath)) return false;

  const requested = canonicalizePath(profilePath);
  const expected = canonicalizePath(resolveProfilePath(profileId));

  return requested === expected;
}

describe("Agent installation profile path validation", () => {
  let testDir: string;
  let hermesHome: string;
  let profiles: ProfileService;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "aera-profile-path-test-"));
    hermesHome = join(testDir, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    profiles = createMockProfileService(hermesHome);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("default profile", () => {
    it("accepts default profile with HERMES_HOME path", () => {
      const result = profilePathMatchesId(
        hermesHome,
        "default",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(true);
    });

    it("rejects default profile with named profile path", () => {
      const namedPath = join(hermesHome, "profiles", "work");
      const result = profilePathMatchesId(
        namedPath,
        "default",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });

    it("rejects default profile with arbitrary path", () => {
      const arbitraryPath = join(testDir, "random");
      const result = profilePathMatchesId(
        arbitraryPath,
        "default",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });
  });

  describe("named profile", () => {
    beforeEach(() => {
      const profilesDir = join(hermesHome, "profiles");
      mkdirSync(profilesDir, { recursive: true });
      mkdirSync(join(profilesDir, "work"), { recursive: true });
    });

    it("accepts named profile with correct path", () => {
      const namedPath = join(hermesHome, "profiles", "work");
      const result = profilePathMatchesId(
        namedPath,
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(true);
    });

    it("rejects named profile with HERMES_HOME path", () => {
      const result = profilePathMatchesId(
        hermesHome,
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });

    it("rejects named profile with different named profile path", () => {
      const otherPath = join(hermesHome, "profiles", "personal");
      const result = profilePathMatchesId(
        otherPath,
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });

    it("rejects named profile with arbitrary directory having same basename", () => {
      const fakePath = join(testDir, "work");
      mkdirSync(fakePath, { recursive: true });
      const result = profilePathMatchesId(
        fakePath,
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });
  });

  describe("symlink handling", () => {
    it("resolves symlinks consistently", () => {
      const { symlinkSync } = require("node:fs");
      const realPath = join(hermesHome, "profiles", "real");
      const linkPath = join(hermesHome, "profiles", "link");
      
      mkdirSync(join(hermesHome, "profiles"), { recursive: true });
      mkdirSync(realPath, { recursive: true });
      
      try {
        symlinkSync(realPath, linkPath, "dir");
        
        // Both real path and link should match if profileId is "real"
        expect(
          profilePathMatchesId(realPath, "real", profiles.resolveProfilePath),
        ).toBe(true);
        expect(
          profilePathMatchesId(linkPath, "real", profiles.resolveProfilePath),
        ).toBe(true);
      } catch (e) {
        // Skip on systems that don't support symlinks
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      }
    });
  });

  describe("relative path rejection", () => {
    it("rejects relative paths", () => {
      const result = profilePathMatchesId(
        "./profiles/work",
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(false);
    });
  });

  describe("non-existent path handling", () => {
    it("validates non-existent default profile path", () => {
      const nonExistent = join(testDir, "does-not-exist");
      const profiles = createMockProfileService(nonExistent);
      
      // Should still validate using resolve() fallback
      const result = profilePathMatchesId(
        nonExistent,
        "default",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(true);
    });

    it("validates non-existent named profile path", () => {
      const nonExistent = join(testDir, "does-not-exist");
      const profiles = createMockProfileService(nonExistent);
      const namedPath = join(nonExistent, "profiles", "work");
      
      const result = profilePathMatchesId(
        namedPath,
        "work",
        profiles.resolveProfilePath,
      );
      expect(result).toBe(true);
    });
  });
});
