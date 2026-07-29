// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgenteraUserProfileStore } from "../src/main/agentera-user-profile-store";

const USER_ONE = "11111111-1111-4111-8111-111111111111";
const USER_TWO = "22222222-2222-4222-8222-222222222222";

describe("Aera local user profile store", () => {
  let root = "";
  let userData = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-user-profile-"));
    userData = join(root, "user-data");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists minimal editable profile data per signed-in user", () => {
    const store = new AgenteraUserProfileStore({
      userDataPath: userData,
      now: () => new Date("2026-07-25T04:00:00.000Z"),
    });

    const saved = store.save(USER_ONE, {
      displayName: "  Alice  ",
      occupation: "  Product designer  ",
      bio: "  Building useful agents.  ",
      avatarDataUrl: "data:image/png;base64,YXZhdGFy",
    });
    store.save(USER_TWO, {
      displayName: "Bob",
      occupation: "",
      bio: "",
      avatarDataUrl: null,
    });

    expect(saved).toEqual({
      userId: USER_ONE,
      displayName: "Alice",
      occupation: "Product designer",
      bio: "Building useful agents.",
      avatarDataUrl: "data:image/png;base64,YXZhdGFy",
      updatedAt: "2026-07-25T04:00:00.000Z",
    });
    expect(
      new AgenteraUserProfileStore({ userDataPath: userData }).get(USER_ONE),
    ).toEqual(saved);
    expect(
      new AgenteraUserProfileStore({ userDataPath: userData }).get(USER_TWO)
        ?.displayName,
    ).toBe("Bob");
    expect(JSON.parse(readFileSync(store.filePath, "utf8"))).toMatchObject({
      schema: "agentera-local-user-profiles",
      version: 1,
    });
  });

  it("rejects invalid or oversized renderer input", () => {
    const store = new AgenteraUserProfileStore({ userDataPath: userData });

    expect(() =>
      store.save(USER_ONE, {
        displayName: "   ",
        occupation: "",
        bio: "",
        avatarDataUrl: null,
      }),
    ).toThrow(/display name/i);
    expect(() =>
      store.save(USER_ONE, {
        displayName: "Alice",
        occupation: "",
        bio: "x".repeat(501),
        avatarDataUrl: null,
      }),
    ).toThrow(/bio/i);
    expect(() =>
      store.save(USER_ONE, {
        displayName: "Alice",
        occupation: "",
        bio: "",
        avatarDataUrl: "https://example.test/avatar.png",
      }),
    ).toThrow(/avatar/i);
  });

  it.runIf(process.platform !== "win32")(
    "writes profile metadata with owner-only permissions",
    () => {
      const store = new AgenteraUserProfileStore({ userDataPath: userData });
      store.save(USER_ONE, {
        displayName: "Alice",
        occupation: "",
        bio: "",
        avatarDataUrl: null,
      });
      expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
    },
  );
});
