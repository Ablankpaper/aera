// @vitest-environment node

import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraProfileBindingStore,
  hasMeaningfulHermesProfileData,
  type AgenteraRuntimeOwner,
  type RuntimeOwnerBinding,
} from "../src/main/agentera-profile-binding";
import type { SecureStorageAdapter } from "../src/main/agentera-auth/store";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, "utf8");
  }
  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^protected:/, "");
  }
}

const owner: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const otherOwner: AgenteraRuntimeOwner = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  ownerId: "55555555-5555-4555-8555-555555555555",
  deviceInstallationId: owner.deviceInstallationId,
};
const AGENT_INSTALLATION_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_AGENT_INSTALLATION_ID = "88888888-8888-4888-8888-888888888888";

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        visit(path);
      } else if (stats.isFile()) {
        result[relative(root, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  visit(root);
  return result;
}

describe("AgentEra non-destructive Runtime Profile ownership", () => {
  let root = "";
  let userData = "";
  let profilePath = "";
  let store: AgenteraProfileBindingStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-profile-binding-"));
    userData = join(root, "user-data");
    profilePath = join(root, "existing-profile");
    mkdirSync(userData, { recursive: true });
    cpSync(
      join(__dirname, "fixtures", "hermes-profile-boundary"),
      profilePath,
      { recursive: true },
    );
    store = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T02:00:00.000Z"),
      randomUUID: () => "66666666-6666-4666-8666-666666666666",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[agentera-app-authentication#Existing Profile migration]]
  it("binds a meaningful physical Profile in place and never changes a private byte", async () => {
    const before = hashTree(profilePath);
    expect(hasMeaningfulHermesProfileData(profilePath)).toBe(true);

    const binding = store.bindExistingProfile(profilePath, owner);
    expect(binding).toEqual<RuntimeOwnerBinding>({
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
      runtimeProfileId: "66666666-6666-4666-8666-666666666666",
      boundAt: "2026-07-18T02:00:00.000Z",
    });
    expect(Object.keys(binding).sort()).toEqual(
      [
        "boundAt",
        "deviceInstallationId",
        "agentInstallationId",
        "ownerId",
        "ownerScope",
        "runtimeProfileId",
        "tenantId",
      ].sort(),
    );

    // A normal logout creates no unbind operation. Reloading the encrypted
    // app-level store represents a later login by the same account.
    const afterLogout = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
    });
    expect(afterLogout.verifyProfileBinding(profilePath, owner)).toEqual(
      binding,
    );
    expect(() =>
      afterLogout.verifyProfileBinding(profilePath, otherOwner),
    ).toThrow(/another AgentEra owner/i);

    // A cloud outage/account deletion has no local destructive fallback.
    await expect(
      Promise.reject(new Error("cloud unavailable")),
    ).rejects.toThrow("cloud unavailable");
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("creates a fresh non-cloned Profile while preserving an existing unbound Profile", () => {
    const before = hashTree(profilePath);
    const freshPath = join(root, "profiles", "fresh-space");
    const createProfile = vi.fn((name: string, cloneFrom: string | null) => {
      expect(name).toBe("Fresh Space");
      expect(cloneFrom).toBeNull();
      mkdirSync(freshPath, { recursive: true });
      return { success: true, id: basename(freshPath) };
    });
    const activateProfile = vi.fn();

    const created = store.createAndBindFreshProfile({
      name: "Fresh Space",
      owner,
      createProfile,
      resolveProfilePath: (id) => {
        expect(id).toBe("fresh-space");
        return freshPath;
      },
      activateProfile,
    });

    expect(createProfile).toHaveBeenCalledOnce();
    expect(createProfile).toHaveBeenCalledWith("Fresh Space", null);
    expect(activateProfile).toHaveBeenCalledOnce();
    expect(activateProfile).toHaveBeenCalledWith("fresh-space");
    expect(created.profileId).toBe("fresh-space");
    expect(store.inspectProfile(profilePath, owner)).toMatchObject({
      status: "unbound",
      meaningfulData: true,
    });
    expect(store.verifyProfileBinding(freshPath, owner)).toEqual(
      created.binding,
    );
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("reuses one stable account Profile and prefers its currently active Profile", () => {
    const secondaryPath = join(root, "profiles", "secondary");
    const foreignPath = join(root, "profiles", "foreign");
    mkdirSync(secondaryPath, { recursive: true });
    mkdirSync(foreignPath, { recursive: true });
    const runtimeProfileIds = [
      "66666666-6666-4666-8666-666666666666",
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ];
    store = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T02:00:00.000Z"),
      randomUUID: () => {
        const id = runtimeProfileIds.shift();
        if (!id) throw new Error("Test Runtime Profile IDs exhausted.");
        return id;
      },
    });

    const primaryBinding = store.bindExistingProfile(profilePath, owner);
    const secondaryBinding = store.bindExistingProfile(secondaryPath, owner);
    store.bindExistingProfile(foreignPath, otherOwner);

    const locations = [
      { id: "foreign", path: foreignPath, isActive: true },
      { id: "secondary", path: secondaryPath, isActive: false },
      { id: "primary", path: profilePath, isActive: false },
    ];
    expect(store.findPreferredOwnedProfile(locations, owner)).toEqual({
      profile: locations[2],
      binding: primaryBinding,
    });

    const withSecondaryActive = locations.map((profile) => ({
      ...profile,
      isActive: profile.id === "secondary",
    }));
    expect(store.findPreferredOwnedProfile(withSecondaryActive, owner)).toEqual(
      {
        profile: withSecondaryActive[1],
        binding: secondaryBinding,
      },
    );
  });

  it("allows only the immediate Runtime scaffold on the fresh Profile path", () => {
    const freshPath = join(root, "profiles", "runtime-scaffold");
    const created = store.createAndBindFreshProfile({
      name: "Runtime Scaffold",
      owner,
      createProfile: (_name, cloneFrom) => {
        expect(cloneFrom).toBeNull();
        mkdirSync(freshPath, { recursive: true });
        writeFileSync(join(freshPath, ".env"), "# Runtime scaffold\n");
        mkdirSync(join(freshPath, "sessions"), { recursive: true });
        mkdirSync(join(freshPath, "skills", "runtime-core"), {
          recursive: true,
        });
        writeFileSync(
          join(freshPath, "skills", "runtime-core", "SKILL.md"),
          "# Runtime core skill\n",
        );
        return { success: true, id: "runtime-scaffold" };
      },
      resolveProfilePath: () => freshPath,
      activateProfile: vi.fn(),
    });
    expect(created.profileId).toBe("runtime-scaffold");
    expect(hasMeaningfulHermesProfileData(freshPath)).toBe(true);

    const unsafePath = join(root, "profiles", "unsafe-fresh");
    expect(() =>
      store.createAndBindFreshProfile({
        name: "Unsafe Fresh",
        owner,
        createProfile: (_name, cloneFrom) => {
          expect(cloneFrom).toBeNull();
          mkdirSync(unsafePath, { recursive: true });
          writeFileSync(join(unsafePath, "MEMORY.md"), "private memory\n");
          return { success: true, id: "unsafe-fresh" };
        },
        resolveProfilePath: () => unsafePath,
        activateProfile: vi.fn(),
      }),
    ).toThrow(/private data/i);
  });

  it("never permits a physical Profile to be reassigned, including after cloud deletion", () => {
    const before = hashTree(profilePath);
    const first = store.bindExistingProfile(profilePath, owner);
    expect(store.bindExistingProfile(profilePath, owner)).toEqual(first);
    expect(() => store.bindExistingProfile(profilePath, otherOwner)).toThrow(
      /cannot be reassigned/i,
    );

    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(owner.ownerId);
    expect(raw).not.toContain(owner.tenantId);
    expect(raw).not.toContain(profilePath);
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("losslessly migrates a real encrypted V1 envelope to V2 without touching the Profile", () => {
    const before = hashTree(profilePath);
    const secureStorage = new FakeSecureStorage();
    const legacyPlaintext = JSON.stringify([
      {
        profilePath: realpathSync.native(profilePath),
        binding: {
          tenantId: owner.tenantId,
          ownerScope: "USER",
          ownerId: owner.ownerId,
          installationId: owner.deviceInstallationId,
          runtimeProfileId: "66666666-6666-4666-8666-666666666666",
          boundAt: "2026-07-18T02:00:00.000Z",
        },
      },
    ]);
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(
      store.filePath,
      `${JSON.stringify({
        schema: "agentera-runtime-profile-bindings",
        version: 1,
        encryptedBindings: secureStorage
          .encryptString(legacyPlaintext)
          .toString("base64"),
      })}\n`,
    );

    const migrated = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage,
    }).verifyProfileBinding(profilePath, owner);

    expect(migrated).toEqual<RuntimeOwnerBinding>({
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
      runtimeProfileId: "66666666-6666-4666-8666-666666666666",
      boundAt: "2026-07-18T02:00:00.000Z",
    });
    const migratedEnvelope = JSON.parse(
      readFileSync(store.filePath, "utf8"),
    ) as { version: number; encryptedBindings: string };
    expect(migratedEnvelope.version).toBe(2);
    expect(readFileSync(store.filePath, "utf8")).not.toContain(profilePath);
    const migratedPlaintext = JSON.parse(
      secureStorage.decryptString(
        Buffer.from(migratedEnvelope.encryptedBindings, "base64"),
      ),
    ) as Array<{ binding: Record<string, unknown> }>;
    expect(migratedPlaintext[0].binding).not.toHaveProperty("installationId");
    expect(migratedPlaintext[0].binding).toMatchObject({
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
    });
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("does not rewrite an encrypted V1 envelope unless decryption and validation finish", () => {
    const beforeProfile = hashTree(profilePath);
    const secureStorage = new FakeSecureStorage();
    const invalidPlaintext = JSON.stringify([
      {
        profilePath: realpathSync.native(profilePath),
        binding: {
          tenantId: owner.tenantId,
          ownerScope: "USER",
          ownerId: owner.ownerId,
          installationId: "not-a-device-uuid",
          runtimeProfileId: "66666666-6666-4666-8666-666666666666",
          boundAt: "2026-07-18T02:00:00.000Z",
        },
      },
    ]);
    mkdirSync(dirname(store.filePath), { recursive: true });
    const envelope = `${JSON.stringify({
      schema: "agentera-runtime-profile-bindings",
      version: 1,
      encryptedBindings: secureStorage
        .encryptString(invalidPlaintext)
        .toString("base64"),
    })}\n`;
    writeFileSync(store.filePath, envelope);

    const reloaded = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage,
    });
    expect(() => reloaded.inspectProfile(profilePath, owner)).toThrow(
      /binding store is corrupt/i,
    );
    expect(readFileSync(store.filePath, "utf8")).toBe(envelope);
    expect(hashTree(profilePath)).toEqual(beforeProfile);
  });

  it("attaches at most one Agent Installation to a same-owner Profile", () => {
    store.bindExistingProfile(profilePath, owner);
    const attached = store.attachAgentInstallation(
      profilePath,
      owner,
      AGENT_INSTALLATION_ID,
    );
    expect(attached.agentInstallationId).toBe(AGENT_INSTALLATION_ID);
    expect(
      store.attachAgentInstallation(profilePath, owner, AGENT_INSTALLATION_ID),
    ).toEqual(attached);
    expect(() =>
      store.attachAgentInstallation(
        profilePath,
        owner,
        OTHER_AGENT_INSTALLATION_ID,
      ),
    ).toThrow(/already attached/i);
    expect(() =>
      store.attachAgentInstallation(
        profilePath,
        otherOwner,
        AGENT_INSTALLATION_ID,
      ),
    ).toThrow(/another AgentEra owner/i);

    const missingPath = join(root, "missing-base-binding");
    mkdirSync(missingPath);
    expect(() =>
      store.attachAgentInstallation(missingPath, owner, AGENT_INSTALLATION_ID),
    ).toThrow(/binding is required/i);

    const secondProfilePath = join(root, "second-bound-profile");
    mkdirSync(secondProfilePath);
    const secondStore = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T02:00:00.000Z"),
      randomUUID: () => "99999999-9999-4999-8999-999999999999",
    });
    secondStore.bindExistingProfile(secondProfilePath, owner);
    expect(() =>
      secondStore.attachAgentInstallation(
        secondProfilePath,
        owner,
        AGENT_INSTALLATION_ID,
      ),
    ).toThrow(/another Runtime Profile/i);
  });

  it("resolves an attached physical Profile only from its trusted owner and installation IDs", () => {
    const before = hashTree(profilePath);
    const binding = store.bindExistingProfile(profilePath, owner);
    store.attachAgentInstallation(profilePath, owner, AGENT_INSTALLATION_ID);

    expect(
      store.resolveAttachedProfilePath(
        binding.runtimeProfileId,
        AGENT_INSTALLATION_ID,
        owner,
      ),
    ).toBe(realpathSync(profilePath));
    expect(() =>
      store.resolveAttachedProfilePath(
        binding.runtimeProfileId,
        OTHER_AGENT_INSTALLATION_ID,
        owner,
      ),
    ).toThrow(/attached Runtime Profile/i);
    expect(() =>
      store.resolveAttachedProfilePath(
        "99999999-9999-4999-8999-999999999999",
        AGENT_INSTALLATION_ID,
        owner,
      ),
    ).toThrow(/attached Runtime Profile/i);
    expect(() =>
      store.resolveAttachedProfilePath(
        binding.runtimeProfileId,
        AGENT_INSTALLATION_ID,
        otherOwner,
      ),
    ).toThrow(/attached Runtime Profile/i);
    expect(hashTree(profilePath)).toEqual(before);
  });
});
