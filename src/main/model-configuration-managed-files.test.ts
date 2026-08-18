// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearManagedModelFileRoots,
  registerManagedModelFileRoots,
  writeManagedModelFile,
} from "./model-configuration-managed-files";
import { ModelConfigurationWriteAuthority } from "./model-configuration-write-authority";

const roots: string[] = [];

afterEach(() => {
  clearManagedModelFileRoots();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed model file boundary", () => {
  it("rejects writes without an active permit before bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-managed-files-"));
    roots.push(root);
    const globalRoot = join(root, "global");
    const profileRoot = join(root, "profile");
    const target = join(profileRoot, ".env");
    registerManagedModelFileRoots({
      globalRoot,
      profiles: { account: profileRoot },
    });

    expect(() => writeManagedModelFile(null, target, "KEY=value\n")).toThrow(
      expect.objectContaining({
        code: "model_configuration_write_permit_required",
      }),
    );
    expect(existsSync(target)).toBe(false);
  });

  it("enforces global and Profile scope on the opaque permit", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-managed-files-"));
    roots.push(root);
    const globalRoot = join(root, "global");
    const profileRoot = join(root, "profile");
    const models = join(globalRoot, "models.json");
    const env = join(profileRoot, ".env");
    registerManagedModelFileRoots({
      globalRoot,
      profiles: { account: profileRoot },
    });
    const authority = new ModelConfigurationWriteAuthority();

    await authority.run(
      { globalCatalog: false, profileIds: ["account"] },
      (permit) => {
        writeManagedModelFile(permit, env, "KEY=value\n");
        expect(() => writeManagedModelFile(permit, models, "[]\n")).toThrow(
          expect.objectContaining({
            code: "model_configuration_write_scope_denied",
          }),
        );
      },
    );

    expect(readFileSync(env, "utf8")).toBe("KEY=value\n");
    expect(existsSync(models)).toBe(false);
  });

  it("writes a global catalog file only within a global permit", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-managed-files-"));
    roots.push(root);
    const globalRoot = join(root, "global");
    registerManagedModelFileRoots({ globalRoot, profiles: {} });
    const models = join(globalRoot, "models.json");
    const authority = new ModelConfigurationWriteAuthority();

    await authority.run({ globalCatalog: true, profileIds: [] }, (permit) => {
      writeManagedModelFile(permit, models, "[]\n");
    });

    expect(readFileSync(models, "utf8")).toBe("[]\n");
  });
});
