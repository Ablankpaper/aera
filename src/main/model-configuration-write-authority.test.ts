// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelConfigurationWriteAuthority,
  currentModelConfigurationWritePermit,
  type ManagedWriteScope,
} from "./model-configuration-write-authority";
import {
  clearManagedModelFileRoots,
  registerManagedModelFileRoots,
  writeManagedModelFile,
} from "./model-configuration-managed-files";
import { safeWriteFile } from "./utils";

const roots: string[] = [];

afterEach(() => {
  clearManagedModelFileRoots();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ModelConfigurationWriteAuthority", () => {
  // @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Recoverable model configuration#Managed lock order is deterministic]]
  it("acquires the global catalog before sorted unique Profile locks", async () => {
    const authority = new ModelConfigurationWriteAuthority();
    const events: string[] = [];
    const scope: ManagedWriteScope = {
      globalCatalog: true,
      profileIds: ["z", "a", "a"],
    };

    await authority.run(scope, async () => {
      events.push("first:global");
      events.push("first:profile:a");
      events.push("first:profile:z");
      events.push("first:write");
    });
    await authority.run(
      { globalCatalog: false, profileIds: ["a"] },
      async () => {
        events.push("second:global");
        events.push("second:profile:a");
        events.push("second:write");
      },
    );

    expect(events).toEqual([
      "first:global",
      "first:profile:a",
      "first:profile:z",
      "first:write",
      "second:global",
      "second:profile:a",
      "second:write",
    ]);
  });

  it("serializes a global-only operation against a Profile operation", async () => {
    const authority = new ModelConfigurationWriteAuthority();
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = authority.run(
      { globalCatalog: true, profileIds: ["profile"] },
      async () => {
        events.push("first:global");
        await held;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = authority.run(
      { globalCatalog: false, profileIds: ["profile"] },
      async () => {
        events.push("second:global");
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first:global"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:global", "second:global"]);
  });

  it("rejects a Profile-to-global nested acquisition before the callback", async () => {
    const authority = new ModelConfigurationWriteAuthority();
    let called = false;
    await expect(
      authority.run({ globalCatalog: false, profileIds: ["p"] }, () =>
        authority.run({ globalCatalog: true, profileIds: [] }, () => {
          called = true;
        }),
      ),
    ).rejects.toMatchObject({ code: "model_configuration_lock_order_violation" });
    expect(called).toBe(false);
  });

  it("does not expose a permit after the authority callback returns", async () => {
    const authority = new ModelConfigurationWriteAuthority();
    let permit: ReturnType<typeof currentModelConfigurationWritePermit> = null;
    await authority.run({ globalCatalog: true, profileIds: ["p"] }, () => {
      permit = currentModelConfigurationWritePermit();
      expect(permit).toBeTruthy();
    });
    expect(currentModelConfigurationWritePermit()).toBeNull();
    expect(permit).toBeTruthy();
  });
});

describe("managed model-file writes", () => {
  it("blocks the shared low-level writer before it creates managed bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-managed-safe-write-"));
    roots.push(root);
    const globalRoot = join(root, "hermes");
    const models = join(globalRoot, "models.json");
    registerManagedModelFileRoots({ globalRoot, profiles: {} });
    const authority = new ModelConfigurationWriteAuthority();

    expect(() => safeWriteFile(models, "[]\n")).toThrow(/permit/i);
    expect(() => readFileSync(models, "utf8")).toThrow();

    await authority.run({ globalCatalog: true, profileIds: [] }, () => {
      safeWriteFile(models, "[]\n");
    });
    expect(readFileSync(models, "utf8")).toBe("[]\n");
  });

  it("requires the active permit and the matching scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-managed-files-"));
    roots.push(root);
    const globalRoot = join(root, "hermes");
    const profileRoot = join(globalRoot, "profiles", "work");
    const models = join(globalRoot, "models.json");
    registerManagedModelFileRoots({
      globalRoot,
      profiles: { work: profileRoot },
    });
    const authority = new ModelConfigurationWriteAuthority();

    expect(() => writeManagedModelFile(null, models, "[]\n")).toThrow(
      /permit/i,
    );
    await authority.run({ globalCatalog: true, profileIds: [] }, () => {
      expect(() =>
        writeManagedModelFile(undefined, models, "implicit\n"),
      ).toThrow(/permit/i);
      writeManagedModelFile(currentModelConfigurationWritePermit(), models, "[]\n");
    });
    expect(readFileSync(models, "utf8")).toBe("[]\n");
    await expect(
      authority.run({ globalCatalog: false, profileIds: ["work"] }, () =>
        writeManagedModelFile(
          currentModelConfigurationWritePermit(),
          models,
          "[1]\n",
        ),
      ),
    ).rejects.toMatchObject({ code: "model_configuration_write_scope_denied" });
  });
});
