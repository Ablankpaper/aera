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
  createAccountSpaceProfileOperationId,
  createAgenteraGuestRuntimeOwner,
  discoverProfilesForCurrentOwner,
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
const OTHER_RUNTIME_PROFILE_ID = "99999999-9999-4999-8999-999999999999";

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

describe("Aera non-destructive Runtime Profile ownership", () => {
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

  // @lat: [[agentera-app-authentication#Startup gate#Guest Profile isolation]]
  it("derives a stable installation-scoped guest owner distinct from cloud owners", () => {
    const first = createAgenteraGuestRuntimeOwner(owner.deviceInstallationId);
    const repeated = createAgenteraGuestRuntimeOwner(
      owner.deviceInstallationId,
    );
    const otherDevice = createAgenteraGuestRuntimeOwner(
      "99999999-9999-4999-8999-999999999999",
    );

    expect(first).toEqual(repeated);
    expect(first.deviceInstallationId).toBe(owner.deviceInstallationId);
    expect(first.tenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.ownerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.tenantId).not.toBe(first.ownerId);
    expect(otherDevice.ownerId).not.toBe(first.ownerId);
  });

  it("derives a stable domain-separated account-space operation id", () => {
    const operationId = createAccountSpaceProfileOperationId(owner);

    expect(operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createAccountSpaceProfileOperationId(owner)).toBe(operationId);
    expect(createAccountSpaceProfileOperationId(otherOwner)).not.toBe(
      operationId,
    );
    expect(operationId).not.toBe(owner.ownerId);
  });

  // @lat: [[agentera-app-authentication#Startup gate#Guest Profile isolation#Profile discovery owner freshness]]
  it("resolves the owner after asynchronous Profile discovery", async () => {
    let finishDiscovery:
      | ((profiles: Array<{ id: string }>) => void)
      | undefined;
    const discoverProfiles = vi.fn(
      () =>
        new Promise<Array<{ id: string }>>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    let currentOwner = owner;
    const getCurrentOwner = vi.fn(() => currentOwner);
    const pending = discoverProfilesForCurrentOwner({
      discoverProfiles,
      getCurrentOwner,
    });

    expect(getCurrentOwner).not.toHaveBeenCalled();
    currentOwner = otherOwner;
    finishDiscovery?.([{ id: "profile-after-auth-transition" }]);

    await expect(pending).resolves.toEqual({
      profiles: [{ id: "profile-after-auth-transition" }],
      owner: otherOwner,
    });
    expect(getCurrentOwner).toHaveBeenCalledOnce();
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
    ).toThrow(/another Aera owner/i);

    // A cloud outage/account deletion has no local destructive fallback.
    await expect(
      Promise.reject(new Error("cloud unavailable")),
    ).rejects.toThrow("cloud unavailable");
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("creates a fresh non-cloned Profile while preserving an existing unbound Profile", async () => {
    const before = hashTree(profilePath);
    const freshPath = join(root, "profiles", "fresh-space");
    const createProfile = vi.fn(
      async (
        name: string,
        cloneFrom: string | null,
        _reservedProfileId?: string,
        activation?: { authorize: () => boolean | Promise<boolean> },
      ) => {
        expect(name).toBe("Fresh Space");
        expect(cloneFrom).toBeNull();
        expect(activation).toBeDefined();
        expect(await activation?.authorize()).toBe(true);
        mkdirSync(freshPath, { recursive: true });
        return { success: true, id: basename(freshPath) };
      },
    );
    const activateProfile = vi.fn();

    const created = await store.createAndBindFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Fresh Space",
      owner,
      profileId: "fresh-space",
      createProfile,
      resolveProfilePath: (id) => {
        expect(id).toBe("fresh-space");
        return freshPath;
      },
      activateProfile,
    });

    expect(createProfile).toHaveBeenCalledOnce();
    expect(createProfile).toHaveBeenCalledWith(
      "Fresh Space",
      null,
      "fresh-space",
      expect.objectContaining({ authorize: expect.any(Function) }),
    );
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

  it("recovers one exact reserved Profile after creation is interrupted", async () => {
    const reservedPath = join(root, "profiles", "reserved-fresh");
    const reservation = store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Reserved Fresh",
      owner,
      profileId: "reserved-fresh",
      activate: false,
    });
    expect(reservation).toMatchObject({
      operationId: AGENT_INSTALLATION_ID,
      profileId: "reserved-fresh",
      runtimeProfileId: "66666666-6666-4666-8666-666666666666",
    });

    const interruptedCreate = vi.fn(
      (name: string, cloneFrom: string | null, reservedProfileId?: string) => {
        expect(name).toBe("Reserved Fresh");
        expect(cloneFrom).toBeNull();
        expect(reservedProfileId).toBe("reserved-fresh");
        mkdirSync(reservedPath, { recursive: true });
        throw new Error("injected creation interruption");
      },
    );
    await expect(
      store.reconcileFreshProfile(AGENT_INSTALLATION_ID, {
        owner,
        createProfile: interruptedCreate,
        resolveProfilePath: () => reservedPath,
        activateProfile: vi.fn(),
      }),
    ).rejects.toThrow("injected creation interruption");

    const restarted = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T03:00:00.000Z"),
      randomUUID: () => OTHER_RUNTIME_PROFILE_ID,
    });
    const duplicateCreate = vi.fn(() => {
      throw new Error("must not create a second Profile");
    });
    const recovered = await restarted.reconcileFreshProfile(
      AGENT_INSTALLATION_ID,
      {
        owner,
        createProfile: duplicateCreate,
        resolveProfilePath: (profileId) => {
          expect(profileId).toBe("reserved-fresh");
          return reservedPath;
        },
        activateProfile: vi.fn(),
      },
    );

    expect(duplicateCreate).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({
      profileId: "reserved-fresh",
      binding: {
        runtimeProfileId: "66666666-6666-4666-8666-666666666666",
        ownerId: owner.ownerId,
      },
    });
    expect(restarted.verifyProfileBinding(reservedPath, owner)).toEqual(
      recovered.binding,
    );
  });

  it("rejects immutable reservation replay drift", () => {
    store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Reserved Fresh",
      owner,
      profileId: "reserved-fresh",
      activate: false,
    });

    expect(() =>
      store.reserveFreshProfile({
        operationId: AGENT_INSTALLATION_ID,
        name: "Reserved Fresh",
        owner: otherOwner,
        profileId: "reserved-fresh",
        activate: false,
      }),
    ).toThrow(/reservation conflict/i);
    expect(() =>
      store.reserveFreshProfile({
        operationId: AGENT_INSTALLATION_ID,
        name: "Reserved Fresh",
        owner,
        profileId: "reserved-fresh-2",
        activate: false,
      }),
    ).toThrow(/reservation conflict/i);
    expect(() =>
      store.reserveFreshProfile({
        operationId: OTHER_AGENT_INSTALLATION_ID,
        name: "Reserved Fresh",
        owner,
        profileId: "reserved-fresh",
        activate: false,
      }),
    ).toThrow(/reservation conflict/i);
  });

  it("looks up a reservation only for its exact owner and operation", () => {
    const reservation = store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Reserved Fresh",
      owner,
      profileId: "reserved-fresh",
      activate: false,
    });

    expect(
      store.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).toEqual(reservation);
    expect(
      store.getFreshProfileReservation(OTHER_AGENT_INSTALLATION_ID, owner),
    ).toBeNull();
    expect(() =>
      store.getFreshProfileReservation(AGENT_INSTALLATION_ID, otherOwner),
    ).toThrow(/reservation conflict/i);
  });

  it("retries activating reservations after restart and completes them only after activation", async () => {
    const reservedPath = join(root, "profiles", "activate-after-restart");
    store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Activate After Restart",
      owner,
      profileId: "activate-after-restart",
    });
    const failedActivation = vi.fn(() => {
      throw new Error("injected activation interruption");
    });

    await expect(
      store.reconcileFreshProfile(AGENT_INSTALLATION_ID, {
        owner,
        createProfile: (_name, _cloneFrom, reservedProfileId) => {
          expect(reservedProfileId).toBe("activate-after-restart");
          mkdirSync(reservedPath, { recursive: true });
          return { success: true, id: reservedProfileId };
        },
        resolveProfilePath: () => reservedPath,
        activateProfile: failedActivation,
      }),
    ).rejects.toThrow("injected activation interruption");
    expect(
      store.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).not.toBeNull();

    const restarted = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      randomUUID: () => OTHER_RUNTIME_PROFILE_ID,
    });
    const activateProfile = vi.fn();
    await expect(
      restarted.reconcileActivatingFreshProfiles({
        owner,
        createProfile: vi.fn(),
        resolveProfilePath: () => reservedPath,
        activateProfile,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        profileId: "activate-after-restart",
        binding: expect.objectContaining({
          runtimeProfileId: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    ]);
    expect(activateProfile).toHaveBeenCalledWith("activate-after-restart");
    expect(
      restarted.getFreshProfileReservation(AGENT_INSTALLATION_ID, owner),
    ).toBeNull();
  });

  it("completes a non-activating reservation only for its exact Runtime Profile", async () => {
    const reservedPath = join(root, "profiles", "installation-reserved");
    store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Installation Reserved",
      owner,
      profileId: "installation-reserved",
      activate: false,
    });
    const reconciled = await store.reconcileFreshProfile(
      AGENT_INSTALLATION_ID,
      {
        owner,
        createProfile: (_name, _cloneFrom, reservedProfileId) => {
          mkdirSync(reservedPath, { recursive: true });
          return { success: true, id: reservedProfileId };
        },
        resolveProfilePath: () => reservedPath,
        activateProfile: vi.fn(),
      },
    );

    expect(() =>
      store.completeFreshProfileReservation(
        AGENT_INSTALLATION_ID,
        owner,
        OTHER_RUNTIME_PROFILE_ID,
      ),
    ).toThrow(/reservation conflict/i);
    expect(
      store.completeFreshProfileReservation(
        AGENT_INSTALLATION_ID,
        owner,
        reconciled.binding.runtimeProfileId,
      ),
    ).toBe(true);
    expect(
      store.completeFreshProfileReservation(
        AGENT_INSTALLATION_ID,
        owner,
        reconciled.binding.runtimeProfileId,
      ),
    ).toBe(false);
  });

  it("does not claim a reserved path already bound to another owner", async () => {
    const reservedPath = join(root, "profiles", "foreign-reserved");
    mkdirSync(reservedPath, { recursive: true });
    store.bindExistingProfile(reservedPath, otherOwner);
    store = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T03:00:00.000Z"),
      randomUUID: () => OTHER_RUNTIME_PROFILE_ID,
    });
    store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Foreign Reserved",
      owner,
      profileId: "foreign-reserved",
      activate: false,
    });

    await expect(
      store.reconcileFreshProfile(AGENT_INSTALLATION_ID, {
        owner,
        createProfile: vi.fn(),
        resolveProfilePath: () => reservedPath,
        activateProfile: vi.fn(),
      }),
    ).rejects.toThrow(/another Aera owner|cannot be reassigned/i);
    expect(store.verifyProfileBinding(reservedPath, otherOwner).ownerId).toBe(
      otherOwner.ownerId,
    );
  });

  it("fails closed when an interrupted reserved Profile contains private markers", async () => {
    const reservedPath = join(root, "profiles", "private-reserved");
    mkdirSync(reservedPath, { recursive: true });
    writeFileSync(join(reservedPath, "MEMORY.md"), "private memory\n");
    store.reserveFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Private Reserved",
      owner,
      profileId: "private-reserved",
      activate: false,
    });

    await expect(
      store.reconcileFreshProfile(AGENT_INSTALLATION_ID, {
        owner,
        createProfile: vi.fn(),
        resolveProfilePath: () => reservedPath,
        activateProfile: vi.fn(),
      }),
    ).rejects.toThrow(/private data/i);
    expect(() => store.verifyProfileBinding(reservedPath, owner)).toThrow(
      /binding is required/i,
    );
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

  it("allows only the immediate Runtime scaffold on the fresh Profile path", async () => {
    const freshPath = join(root, "profiles", "runtime-scaffold");
    const created = await store.createAndBindFreshProfile({
      operationId: AGENT_INSTALLATION_ID,
      name: "Runtime Scaffold",
      owner,
      profileId: "runtime-scaffold",
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
    store = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T03:00:00.000Z"),
      randomUUID: () => OTHER_RUNTIME_PROFILE_ID,
    });
    await expect(
      store.createAndBindFreshProfile({
        operationId: OTHER_AGENT_INSTALLATION_ID,
        name: "Unsafe Fresh",
        owner,
        profileId: "unsafe-fresh",
        createProfile: (_name, cloneFrom) => {
          expect(cloneFrom).toBeNull();
          mkdirSync(unsafePath, { recursive: true });
          writeFileSync(join(unsafePath, "MEMORY.md"), "private memory\n");
          return { success: true, id: "unsafe-fresh" };
        },
        resolveProfilePath: () => unsafePath,
        activateProfile: vi.fn(),
      }),
    ).rejects.toThrow(/private data/i);
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

  it("losslessly migrates a real encrypted V1 envelope to V3 without touching the Profile", () => {
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
    expect(migratedEnvelope.version).toBe(3);
    expect(readFileSync(store.filePath, "utf8")).not.toContain(profilePath);
    const migratedPlaintext = JSON.parse(
      secureStorage.decryptString(
        Buffer.from(migratedEnvelope.encryptedBindings, "base64"),
      ),
    ) as {
      bindings: Array<{ binding: Record<string, unknown> }>;
      freshProfileOperations: unknown[];
    };
    expect(migratedPlaintext.bindings[0].binding).not.toHaveProperty(
      "installationId",
    );
    expect(migratedPlaintext.bindings[0].binding).toMatchObject({
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
    });
    expect(migratedPlaintext.freshProfileOperations).toEqual([]);
    expect(hashTree(profilePath)).toEqual(before);
  });

  it("migrates an encrypted V2 binding array to V3 state", () => {
    const secureStorage = new FakeSecureStorage();
    const binding: RuntimeOwnerBinding = {
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
      runtimeProfileId: "66666666-6666-4666-8666-666666666666",
      boundAt: "2026-07-18T02:00:00.000Z",
    };
    const legacyPlaintext = JSON.stringify([
      { profilePath: realpathSync.native(profilePath), binding },
    ]);
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(
      store.filePath,
      `${JSON.stringify({
        schema: "agentera-runtime-profile-bindings",
        version: 2,
        encryptedBindings: secureStorage
          .encryptString(legacyPlaintext)
          .toString("base64"),
      })}\n`,
    );

    const migrated = new AgenteraProfileBindingStore({
      userDataPath: userData,
      secureStorage,
    });
    expect(migrated.verifyProfileBinding(profilePath, owner)).toEqual(binding);
    const envelope = JSON.parse(readFileSync(store.filePath, "utf8")) as {
      version: number;
      encryptedBindings: string;
    };
    expect(envelope.version).toBe(3);
    expect(
      JSON.parse(
        secureStorage.decryptString(
          Buffer.from(envelope.encryptedBindings, "base64"),
        ),
      ),
    ).toEqual({
      bindings: [{ profilePath: realpathSync.native(profilePath), binding }],
      freshProfileOperations: [],
    });
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
    ).toThrow(/another Aera owner/i);

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
    ).toBe(realpathSync.native(profilePath));
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
