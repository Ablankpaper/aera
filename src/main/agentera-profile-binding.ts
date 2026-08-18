import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SecureStorageAdapter } from "./agentera-auth/store";
import { safeWriteFile } from "./utils";

const PROFILE_BINDING_SCHEMA = "agentera-runtime-profile-bindings" as const;
const PROFILE_BINDING_VERSION_V1 = 1 as const;
const PROFILE_BINDING_VERSION_V2 = 2 as const;
const PROFILE_BINDING_VERSION = 3 as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgenteraRuntimeOwner {
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
}

export interface RuntimeOwnerBinding {
  tenantId: string;
  ownerScope: "USER";
  ownerId: string;
  deviceInstallationId: string;
  agentInstallationId: string | null;
  runtimeProfileId: string;
  boundAt: string;
}

interface RuntimeOwnerBindingV1 {
  tenantId: string;
  ownerScope: "USER";
  ownerId: string;
  installationId: string;
  runtimeProfileId: string;
  boundAt: string;
}

interface StoredProfileBinding {
  profilePath: string;
  binding: RuntimeOwnerBinding;
}

interface StoredProfileBindingV1 {
  profilePath: string;
  binding: RuntimeOwnerBindingV1;
}

export interface FreshProfileReservation {
  operationId: string;
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
  profileId: string;
  runtimeProfileId: string;
  displayName: string;
  activate: boolean;
  createdAt: string;
}

interface RuntimeProfileBindingStateV3 {
  bindings: StoredProfileBinding[];
  freshProfileOperations: FreshProfileReservation[];
}

interface BindingEnvelope {
  schema: typeof PROFILE_BINDING_SCHEMA;
  version: typeof PROFILE_BINDING_VERSION;
  encryptedBindings: string;
}

interface BindingEnvelopeV1 {
  schema: typeof PROFILE_BINDING_SCHEMA;
  version: typeof PROFILE_BINDING_VERSION_V1;
  encryptedBindings: string;
}

interface BindingEnvelopeV2 {
  schema: typeof PROFILE_BINDING_SCHEMA;
  version: typeof PROFILE_BINDING_VERSION_V2;
  encryptedBindings: string;
}

export interface ProfileBindingStoreOptions {
  userDataPath: string;
  secureStorage: SecureStorageAdapter;
  writeFile?: (path: string, content: string) => void;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ProfileCreationResult {
  success: boolean;
  error?: string;
  id?: string;
}

export interface FreshProfileBindingRequest {
  operationId: string;
  name: string;
  owner: AgenteraRuntimeOwner;
  profileId: string;
  createProfile: (
    name: string,
    cloneFrom: string | null,
    reservedProfileId?: string,
    activation?: { authorize: () => boolean | Promise<boolean> },
  ) => ProfileCreationResult | Promise<ProfileCreationResult>;
  resolveProfilePath: (profileId: string) => string;
  activateProfile: (profileId: string) => void;
  activate?: boolean;
}

export interface FreshProfileReservationRequest {
  operationId: string;
  name: string;
  owner: AgenteraRuntimeOwner;
  profileId: string;
  activate?: boolean;
}

export interface FreshProfileReconciliationAdapters {
  owner: AgenteraRuntimeOwner;
  createProfile: (
    name: string,
    cloneFrom: string | null,
    reservedProfileId?: string,
    activation?: { authorize: () => boolean | Promise<boolean> },
  ) => ProfileCreationResult | Promise<ProfileCreationResult>;
  resolveProfilePath: (profileId: string) => string;
  activateProfile: (profileId: string) => void;
}

export type ProfileClaimInspection =
  | { status: "unbound"; meaningfulData: boolean }
  | {
      status: "owned";
      meaningfulData: boolean;
      isCurrentOwner: boolean;
      binding: RuntimeOwnerBinding;
    };

export type AgenteraProfileBindingRepairCode =
  | "profile_owner_conflict"
  | "profile_reservation_conflict"
  | "runtime_profile_conflict"
  | "profile_private_data_conflict";

export class AgenteraProfileBindingRepairError extends Error {
  readonly code: AgenteraProfileBindingRepairCode;

  constructor(code: AgenteraProfileBindingRepairCode, message: string) {
    super(message);
    this.name = "AgenteraProfileBindingRepairError";
    this.code = code;
  }
}

const PRIVATE_PROFILE_MARKERS = [
  ".env",
  "auth.json",
  "MEMORY.md",
  "USER.md",
  "sessions",
  "files",
  "skills",
  "curator",
  ".curator",
] as const;
const FRESH_PROFILE_FORBIDDEN_MARKERS = PRIVATE_PROFILE_MARKERS.filter(
  (marker) => marker !== ".env" && marker !== "sessions" && marker !== "skills",
);

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function deterministicUuid(input: string): string {
  const bytes = createHash("sha256")
    .update(input, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function deterministicGuestUuid(
  scope: "tenant" | "owner",
  deviceInstallationId: string,
): string {
  return deterministicUuid(
    `agentera-local-guest:${scope}:${deviceInstallationId}`,
  );
}

/**
 * Derive a stable, device-local owner for guest Profiles without minting a
 * cloud identity. The installation ID keeps guest data isolated per device;
 * domain-separated hashes avoid colliding with either real account field.
 */
export function createAgenteraGuestRuntimeOwner(
  deviceInstallationId: string,
): AgenteraRuntimeOwner {
  if (!validUuid(deviceInstallationId)) {
    throw new Error("Aera guest installation identity is invalid.");
  }
  return {
    tenantId: deterministicGuestUuid("tenant", deviceInstallationId),
    ownerId: deterministicGuestUuid("owner", deviceInstallationId),
    deviceInstallationId,
  };
}

export function createAccountSpaceProfileOperationId(
  owner: AgenteraRuntimeOwner,
): string {
  assertOwner(owner);
  return deterministicUuid(
    [
      "agentera-account-space-profile-operation",
      owner.tenantId,
      owner.ownerId,
      owner.deviceInstallationId,
    ].join(":"),
  );
}

/**
 * Profile discovery crosses an asynchronous filesystem boundary. Resolve the
 * owner only after that boundary so a guest sign-in, sign-out, or account
 * switch cannot bind the discovered Profile with a stale principal.
 */
export async function discoverProfilesForCurrentOwner<T>(options: {
  discoverProfiles: () => Promise<T>;
  getCurrentOwner: () => AgenteraRuntimeOwner;
}): Promise<{ profiles: T; owner: AgenteraRuntimeOwner }> {
  const profiles = await options.discoverProfiles();
  const owner = options.getCurrentOwner();
  assertOwner(owner);
  return { profiles, owner };
}

function exactKeys(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validBoundAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertOwner(owner: AgenteraRuntimeOwner): void {
  if (
    !validUuid(owner.tenantId) ||
    !validUuid(owner.ownerId) ||
    !validUuid(owner.deviceInstallationId)
  ) {
    throw new Error("Aera Runtime owner identity is invalid.");
  }
}

function validBinding(value: unknown): value is RuntimeOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RuntimeOwnerBinding>;
  return (
    exactKeys(value, [
      "tenantId",
      "ownerScope",
      "ownerId",
      "deviceInstallationId",
      "agentInstallationId",
      "runtimeProfileId",
      "boundAt",
    ]) &&
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.deviceInstallationId) &&
    (record.agentInstallationId === null ||
      validUuid(record.agentInstallationId)) &&
    validUuid(record.runtimeProfileId) &&
    validBoundAt(record.boundAt)
  );
}

function validBindingV1(value: unknown): value is RuntimeOwnerBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RuntimeOwnerBindingV1>;
  return (
    exactKeys(value, [
      "tenantId",
      "ownerScope",
      "ownerId",
      "installationId",
      "runtimeProfileId",
      "boundAt",
    ]) &&
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.installationId) &&
    validUuid(record.runtimeProfileId) &&
    validBoundAt(record.boundAt)
  );
}

function validProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "default" &&
    /^[a-z0-9_][a-z0-9_-]{0,63}$/.test(value)
  );
}

function validDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

function validFreshProfileReservation(
  value: unknown,
): value is FreshProfileReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<FreshProfileReservation>;
  return (
    exactKeys(value, [
      "operationId",
      "tenantId",
      "ownerId",
      "deviceInstallationId",
      "profileId",
      "runtimeProfileId",
      "displayName",
      "activate",
      "createdAt",
    ]) &&
    validUuid(record.operationId) &&
    validUuid(record.tenantId) &&
    validUuid(record.ownerId) &&
    validUuid(record.deviceInstallationId) &&
    validProfileId(record.profileId) &&
    validUuid(record.runtimeProfileId) &&
    validDisplayName(record.displayName) &&
    typeof record.activate === "boolean" &&
    validBoundAt(record.createdAt)
  );
}

function canonicalProfilePath(profilePath: string): string {
  if (typeof profilePath !== "string" || !isAbsolute(profilePath)) {
    throw new Error("Aera Runtime Profile path must be absolute.");
  }
  let canonical: string;
  try {
    canonical = resolve(realpathSync.native(profilePath));
  } catch {
    throw new Error("Aera Runtime Profile path does not exist.");
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Aera Runtime Profile path must be a directory.");
  }
  return canonical;
}

function markerHasData(markerPath: string): boolean {
  let stats;
  try {
    stats = lstatSync(markerPath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return true;
  if (stats.isFile()) return stats.size > 0;
  if (!stats.isDirectory()) return false;
  try {
    return readdirSync(markerPath).length > 0;
  } catch {
    return true;
  }
}

/**
 * Detect only approved local metadata markers. File contents are never opened,
 * parsed, hashed for upload, copied, or returned.
 */
export function hasMeaningfulHermesProfileData(profilePath: string): boolean {
  const canonical = canonicalProfilePath(profilePath);
  return PRIVATE_PROFILE_MARKERS.some((marker) =>
    markerHasData(join(canonical, marker)),
  );
}

function freshProfileHasPrivateData(profilePath: string): boolean {
  const canonical = canonicalProfilePath(profilePath);
  return FRESH_PROFILE_FORBIDDEN_MARKERS.some((marker) =>
    markerHasData(join(canonical, marker)),
  );
}

function sameOwner(
  binding: RuntimeOwnerBinding,
  owner: AgenteraRuntimeOwner,
): boolean {
  return (
    binding.tenantId === owner.tenantId &&
    binding.ownerId === owner.ownerId &&
    binding.deviceInstallationId === owner.deviceInstallationId
  );
}

function reservationHasOwner(
  reservation: FreshProfileReservation,
  owner: AgenteraRuntimeOwner,
): boolean {
  return (
    reservation.tenantId === owner.tenantId &&
    reservation.ownerId === owner.ownerId &&
    reservation.deviceInstallationId === owner.deviceInstallationId
  );
}

function reservationMatchesRequest(
  reservation: FreshProfileReservation,
  request: FreshProfileReservationRequest,
): boolean {
  return (
    reservation.operationId === request.operationId &&
    reservationHasOwner(reservation, request.owner) &&
    reservation.profileId === request.profileId &&
    reservation.displayName === request.name &&
    reservation.activate === (request.activate !== false)
  );
}

export class AgenteraProfileBindingStore {
  readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private readonly writeFile: (path: string, content: string) => void;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: ProfileBindingStoreOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Electron userData path must be absolute.");
    }
    this.filePath = join(
      resolve(options.userDataPath),
      "agentera-auth",
      "profile-bindings.json",
    );
    this.secureStorage = options.secureStorage;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  inspectProfile(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): ProfileClaimInspection {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const stored = this.readBindings().find(
      (entry) => entry.profilePath === canonical,
    );
    const meaningfulData = hasMeaningfulHermesProfileData(canonical);
    if (!stored) return { status: "unbound", meaningfulData };
    return {
      status: "owned",
      meaningfulData,
      isCurrentOwner: sameOwner(stored.binding, owner),
      binding: { ...stored.binding },
    };
  }

  /**
   * Resolve the account's primary local Profile without exposing any Profile
   * path or owner metadata to the renderer. The active owned Profile wins;
   * otherwise the earliest binding is the stable account home across logins.
   */
  findPreferredOwnedProfile<T extends { path: string; isActive: boolean }>(
    profiles: readonly T[],
    owner: AgenteraRuntimeOwner,
  ): { profile: T; binding: RuntimeOwnerBinding } | null {
    assertOwner(owner);
    const bindings = this.readBindings();
    const candidates: Array<{
      profile: T;
      binding: RuntimeOwnerBinding;
      bindingOrder: number;
      canonicalPath: string;
    }> = [];

    for (const profile of profiles) {
      let canonicalPath: string;
      try {
        canonicalPath = canonicalProfilePath(profile.path);
      } catch {
        continue;
      }
      const bindingOrder = bindings.findIndex(
        (entry) =>
          entry.profilePath === canonicalPath &&
          sameOwner(entry.binding, owner),
      );
      if (bindingOrder < 0) continue;
      candidates.push({
        profile,
        binding: bindings[bindingOrder].binding,
        bindingOrder,
        canonicalPath,
      });
    }

    candidates.sort(
      (left, right) =>
        Number(right.profile.isActive) - Number(left.profile.isActive) ||
        left.bindingOrder - right.bindingOrder ||
        left.canonicalPath.localeCompare(right.canonicalPath),
    );
    const selected = candidates[0];
    return selected
      ? {
          profile: selected.profile,
          binding: { ...selected.binding },
        }
      : null;
  }

  bindExistingProfile(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): RuntimeOwnerBinding {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const bindings = this.readBindings();
    const existing = bindings.find((entry) => entry.profilePath === canonical);
    if (existing) {
      if (sameOwner(existing.binding, owner)) return { ...existing.binding };
      throw new AgenteraProfileBindingRepairError(
        "profile_owner_conflict",
        "This physical Runtime Profile cannot be reassigned to another Aera owner.",
      );
    }

    const runtimeProfileId = this.randomUUID();
    if (
      !validUuid(runtimeProfileId) ||
      bindings.some(
        (entry) => entry.binding.runtimeProfileId === runtimeProfileId,
      )
    ) {
      throw new Error("Aera Runtime Profile ID generation failed.");
    }
    const binding: RuntimeOwnerBinding = {
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: null,
      runtimeProfileId,
      boundAt: this.now().toISOString(),
    };
    bindings.push({ profilePath: canonical, binding });
    this.persistBindings(bindings);
    return { ...binding };
  }

  reserveFreshProfile(
    request: FreshProfileReservationRequest,
  ): FreshProfileReservation {
    assertOwner(request.owner);
    if (
      !validUuid(request.operationId) ||
      !validDisplayName(request.name) ||
      !validProfileId(request.profileId)
    ) {
      throw new Error("Aera fresh Profile reservation identity is invalid.");
    }
    const state = this.readState();
    const existing = state.freshProfileOperations.find(
      (candidate) => candidate.operationId === request.operationId,
    );
    if (existing) {
      if (!reservationMatchesRequest(existing, request)) {
        throw new AgenteraProfileBindingRepairError(
          "profile_reservation_conflict",
          "Aera fresh Profile reservation conflict.",
        );
      }
      return { ...existing };
    }
    if (
      state.freshProfileOperations.some(
        (candidate) => candidate.profileId === request.profileId,
      )
    ) {
      throw new AgenteraProfileBindingRepairError(
        "profile_reservation_conflict",
        "Aera fresh Profile reservation conflict.",
      );
    }
    const runtimeProfileId = this.randomUUID();
    if (
      !validUuid(runtimeProfileId) ||
      state.bindings.some(
        (entry) => entry.binding.runtimeProfileId === runtimeProfileId,
      ) ||
      state.freshProfileOperations.some(
        (candidate) => candidate.runtimeProfileId === runtimeProfileId,
      )
    ) {
      throw new Error("Aera Runtime Profile ID generation failed.");
    }
    const reservation: FreshProfileReservation = {
      operationId: request.operationId,
      tenantId: request.owner.tenantId,
      ownerId: request.owner.ownerId,
      deviceInstallationId: request.owner.deviceInstallationId,
      profileId: request.profileId,
      runtimeProfileId,
      displayName: request.name,
      activate: request.activate !== false,
      createdAt: this.now().toISOString(),
    };
    if (!validFreshProfileReservation(reservation)) {
      throw new Error("Aera fresh Profile reservation identity is invalid.");
    }
    state.freshProfileOperations.push(reservation);
    this.persistState(state);
    return { ...reservation };
  }

  getFreshProfileReservation(
    operationId: string,
    owner: AgenteraRuntimeOwner,
  ): FreshProfileReservation | null {
    assertOwner(owner);
    if (!validUuid(operationId)) {
      throw new Error("Aera fresh Profile reservation identity is invalid.");
    }
    const reservation = this.readState().freshProfileOperations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!reservation) return null;
    if (!reservationHasOwner(reservation, owner)) {
      throw new Error("Aera fresh Profile reservation conflict.");
    }
    return { ...reservation };
  }

  completeFreshProfileReservation(
    operationId: string,
    owner: AgenteraRuntimeOwner,
    runtimeProfileId: string,
  ): boolean {
    assertOwner(owner);
    if (!validUuid(operationId) || !validUuid(runtimeProfileId)) {
      throw new Error("Aera fresh Profile reservation identity is invalid.");
    }
    const state = this.readState();
    const operationIndex = state.freshProfileOperations.findIndex(
      (candidate) => candidate.operationId === operationId,
    );
    if (operationIndex < 0) return false;
    const reservation = state.freshProfileOperations[operationIndex];
    const binding = state.bindings.find(
      (entry) => entry.binding.runtimeProfileId === runtimeProfileId,
    );
    if (
      !reservationHasOwner(reservation, owner) ||
      reservation.runtimeProfileId !== runtimeProfileId ||
      !binding ||
      !sameOwner(binding.binding, owner)
    ) {
      throw new Error("Aera fresh Profile reservation conflict.");
    }
    state.freshProfileOperations.splice(operationIndex, 1);
    this.persistState(state);
    return true;
  }

  async reconcileActivatingFreshProfiles(
    adapters: FreshProfileReconciliationAdapters,
  ): Promise<Array<{ profileId: string; binding: RuntimeOwnerBinding }>> {
    assertOwner(adapters.owner);
    const operationIds = this.readState()
      .freshProfileOperations.filter(
        (reservation) =>
          reservation.activate &&
          reservationHasOwner(reservation, adapters.owner),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.operationId.localeCompare(right.operationId),
      )
      .map((reservation) => reservation.operationId);
    const reconciled: Array<{
      profileId: string;
      binding: RuntimeOwnerBinding;
    }> = [];
    for (const operationId of operationIds) {
      reconciled.push(await this.reconcileFreshProfile(operationId, adapters));
    }
    return reconciled;
  }

  async reconcileFreshProfile(
    operationId: string,
    adapters: FreshProfileReconciliationAdapters,
  ): Promise<{
    profileId: string;
    binding: RuntimeOwnerBinding;
  }> {
    assertOwner(adapters.owner);
    if (!validUuid(operationId)) {
      throw new Error("Aera fresh Profile reservation identity is invalid.");
    }
    let state = this.readState();
    let reservation = state.freshProfileOperations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!reservation) {
      throw new Error("Aera fresh Profile reservation is required.");
    }
    if (!reservationHasOwner(reservation, adapters.owner)) {
      throw new Error("Aera fresh Profile reservation conflict.");
    }
    const profilePath = adapters.resolveProfilePath(reservation.profileId);
    if (!existsSync(profilePath)) {
      // This is deliberately the only call shape: no source Profile or
      // private path can enter the generic Hermes cloning argument. The
      // reservation reached durable encrypted storage before this callback.
      const created = await adapters.createProfile(
        reservation.displayName,
        null,
        reservation.profileId,
        {
          authorize: () => {
            const current = this.readState().freshProfileOperations.find(
              (candidate) => candidate.operationId === reservation?.operationId,
            );
            return (
              current !== undefined &&
              reservationHasOwner(current, adapters.owner) &&
              current.profileId === reservation?.profileId &&
              current.runtimeProfileId === reservation?.runtimeProfileId
            );
          },
        },
      );
      if (
        !created.success ||
        !created.id ||
        created.id !== reservation.profileId
      ) {
        throw new Error("Fresh Runtime Profile creation failed.");
      }
    }
    // Hermes creates .env, sessions, and built-in Skill scaffolding even when
    // cloneFrom is null. They belong to this newly-created physical Profile;
    // none is read or copied here. Memory, USER, files, auth, and Curator
    // markers remain forbidden before activation can start local adaptation.
    if (freshProfileHasPrivateData(profilePath)) {
      throw new AgenteraProfileBindingRepairError(
        "profile_private_data_conflict",
        "Fresh Runtime Profile creation unexpectedly produced private data.",
      );
    }
    const canonical = canonicalProfilePath(profilePath);
    state = this.readState();
    reservation = state.freshProfileOperations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!reservation || !reservationHasOwner(reservation, adapters.owner)) {
      throw new Error("Aera fresh Profile reservation conflict.");
    }
    let stored = state.bindings.find(
      (entry) => entry.profilePath === canonical,
    );
    if (stored) {
      if (!sameOwner(stored.binding, adapters.owner)) {
        throw new AgenteraProfileBindingRepairError(
          "profile_owner_conflict",
          "This physical Runtime Profile cannot be reassigned to another Aera owner.",
        );
      }
      if (stored.binding.runtimeProfileId !== reservation.runtimeProfileId) {
        throw new AgenteraProfileBindingRepairError(
          "runtime_profile_conflict",
          "Aera fresh Profile reservation conflict.",
        );
      }
    } else {
      if (
        state.bindings.some(
          (entry) =>
            entry.binding.runtimeProfileId === reservation.runtimeProfileId,
        )
      ) {
        throw new AgenteraProfileBindingRepairError(
          "runtime_profile_conflict",
          "Aera fresh Profile reservation conflict.",
        );
      }
      stored = {
        profilePath: canonical,
        binding: {
          tenantId: reservation.tenantId,
          ownerScope: "USER",
          ownerId: reservation.ownerId,
          deviceInstallationId: reservation.deviceInstallationId,
          agentInstallationId: null,
          runtimeProfileId: reservation.runtimeProfileId,
          boundAt: reservation.createdAt,
        },
      };
      state.bindings.push(stored);
      // Keep the operation as an idempotency record. The installation journal
      // can safely finish later phases and a cold retry still resolves the
      // exact same physical and Runtime Profile identities.
      this.persistState(state);
    }
    if (reservation.activate) {
      adapters.activateProfile(reservation.profileId);
      const completedState = this.readState();
      const operationIndex = completedState.freshProfileOperations.findIndex(
        (candidate) => candidate.operationId === operationId,
      );
      if (operationIndex < 0) {
        throw new Error("Aera fresh Profile reservation conflict.");
      }
      const completedReservation =
        completedState.freshProfileOperations[operationIndex];
      const completedBinding = completedState.bindings.find(
        (entry) => entry.profilePath === canonical,
      );
      if (
        !reservationHasOwner(completedReservation, adapters.owner) ||
        completedReservation.runtimeProfileId !==
          reservation.runtimeProfileId ||
        !completedBinding ||
        !sameOwner(completedBinding.binding, adapters.owner) ||
        completedBinding.binding.runtimeProfileId !==
          reservation.runtimeProfileId
      ) {
        throw new Error("Aera fresh Profile reservation conflict.");
      }
      completedState.freshProfileOperations.splice(operationIndex, 1);
      this.persistState(completedState);
    }
    return {
      profileId: reservation.profileId,
      binding: { ...stored.binding },
    };
  }

  async createAndBindFreshProfile(
    request: FreshProfileBindingRequest,
  ): Promise<{
    profileId: string;
    binding: RuntimeOwnerBinding;
  }> {
    this.reserveFreshProfile({
      operationId: request.operationId,
      name: request.name,
      owner: request.owner,
      profileId: request.profileId,
      activate: request.activate,
    });
    return this.reconcileFreshProfile(request.operationId, {
      owner: request.owner,
      createProfile: request.createProfile,
      resolveProfilePath: request.resolveProfilePath,
      activateProfile: request.activateProfile,
    });
  }

  listUnboundProfiles<T extends { path: string }>(profiles: T[]): T[] {
    const boundPaths = new Set(
      this.readBindings().map((entry) => entry.profilePath),
    );
    return profiles.filter((profile) => {
      try {
        return !boundPaths.has(canonicalProfilePath(profile.path));
      } catch {
        return false;
      }
    });
  }

  verifyProfileBinding(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): RuntimeOwnerBinding {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const stored = this.readBindings().find(
      (entry) => entry.profilePath === canonical,
    );
    if (!stored) {
      throw new Error("Aera Runtime Profile binding is required.");
    }
    if (!sameOwner(stored.binding, owner)) {
      throw new Error("This Runtime Profile belongs to another Aera owner.");
    }
    return { ...stored.binding };
  }

  attachAgentInstallation(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
    agentInstallationId: string,
  ): RuntimeOwnerBinding {
    assertOwner(owner);
    if (!validUuid(agentInstallationId)) {
      throw new Error("Aera Agent Installation ID is invalid.");
    }
    const canonical = canonicalProfilePath(profilePath);
    const bindings = this.readBindings();
    const stored = bindings.find((entry) => entry.profilePath === canonical);
    if (!stored) {
      throw new Error("Aera Runtime Profile binding is required.");
    }
    if (!sameOwner(stored.binding, owner)) {
      throw new Error("This Runtime Profile belongs to another Aera owner.");
    }
    if (stored.binding.agentInstallationId === agentInstallationId) {
      return { ...stored.binding };
    }
    if (stored.binding.agentInstallationId !== null) {
      throw new Error(
        "This Runtime Profile is already attached to an Agent Installation.",
      );
    }
    if (
      bindings.some(
        (entry) =>
          entry.profilePath !== canonical &&
          entry.binding.agentInstallationId === agentInstallationId,
      )
    ) {
      throw new Error(
        "This Agent Installation is already attached to another Runtime Profile.",
      );
    }
    stored.binding.agentInstallationId = agentInstallationId;
    this.persistBindings(bindings);
    return { ...stored.binding };
  }

  removeProfileBinding(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
    expected: {
      runtimeProfileId: string;
      agentInstallationId: string | null;
    },
  ): boolean {
    assertOwner(owner);
    if (
      !validUuid(expected.runtimeProfileId) ||
      (expected.agentInstallationId !== null &&
        !validUuid(expected.agentInstallationId))
    ) {
      throw new Error("Aera Runtime Profile binding identity is invalid.");
    }
    const canonical = canonicalProfilePath(profilePath);
    const bindings = this.readBindings();
    const index = bindings.findIndex(
      (entry) => entry.profilePath === canonical,
    );
    if (index < 0) return false;
    const stored = bindings[index];
    if (
      !sameOwner(stored.binding, owner) ||
      stored.binding.runtimeProfileId !== expected.runtimeProfileId ||
      stored.binding.agentInstallationId !== expected.agentInstallationId
    ) {
      throw new Error(
        "Aera Runtime Profile binding cannot be removed by this restore transaction.",
      );
    }
    bindings.splice(index, 1);
    this.persistBindings(bindings);
    return true;
  }

  resolveAttachedProfilePath(
    runtimeProfileId: string,
    agentInstallationId: string,
    owner: AgenteraRuntimeOwner,
  ): string {
    assertOwner(owner);
    if (!validUuid(runtimeProfileId) || !validUuid(agentInstallationId)) {
      throw new Error("Attached Runtime Profile identity is invalid.");
    }
    const stored = this.readBindings().find(
      (entry) =>
        entry.binding.runtimeProfileId === runtimeProfileId &&
        entry.binding.agentInstallationId === agentInstallationId &&
        sameOwner(entry.binding, owner),
    );
    if (!stored) {
      throw new Error("Attached Runtime Profile is unavailable.");
    }
    return canonicalProfilePath(stored.profilePath);
  }

  private readBindings(): StoredProfileBinding[] {
    return this.readState().bindings.map((entry) => ({
      profilePath: entry.profilePath,
      binding: { ...entry.binding },
    }));
  }

  private readState(): RuntimeProfileBindingStateV3 {
    if (!existsSync(this.filePath)) {
      return { bindings: [], freshProfileOperations: [] };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    const candidate = envelope as Partial<
      BindingEnvelope | BindingEnvelopeV1 | BindingEnvelopeV2
    >;
    if (
      !exactKeys(envelope, ["schema", "version", "encryptedBindings"]) ||
      candidate.schema !== PROFILE_BINDING_SCHEMA ||
      (candidate.version !== PROFILE_BINDING_VERSION_V1 &&
        candidate.version !== PROFILE_BINDING_VERSION_V2 &&
        candidate.version !== PROFILE_BINDING_VERSION) ||
      typeof candidate.encryptedBindings !== "string"
    ) {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    this.requireEncryption();
    let parsed: unknown;
    try {
      const plaintext = this.secureStorage.decryptString(
        Buffer.from(candidate.encryptedBindings, "base64"),
      );
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    const isV1 = candidate.version === PROFILE_BINDING_VERSION_V1;
    const validEntry = (entry: unknown): boolean => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const stored = entry as Partial<
        StoredProfileBinding | StoredProfileBindingV1
      >;
      return (
        exactKeys(entry, ["profilePath", "binding"]) &&
        typeof stored.profilePath === "string" &&
        isAbsolute(stored.profilePath) &&
        (isV1 ? validBindingV1(stored.binding) : validBinding(stored.binding))
      );
    };
    const parsedBindings =
      candidate.version === PROFILE_BINDING_VERSION
        ? (parsed as Partial<RuntimeProfileBindingStateV3> | null)?.bindings
        : parsed;
    const parsedOperations =
      candidate.version === PROFILE_BINDING_VERSION
        ? (parsed as Partial<RuntimeProfileBindingStateV3> | null)
            ?.freshProfileOperations
        : [];
    if (
      (candidate.version === PROFILE_BINDING_VERSION &&
        (!parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !exactKeys(parsed, ["bindings", "freshProfileOperations"]))) ||
      !Array.isArray(parsedBindings) ||
      parsedBindings.some((entry) => !validEntry(entry)) ||
      !Array.isArray(parsedOperations) ||
      parsedOperations.some(
        (operation) => !validFreshProfileReservation(operation),
      )
    ) {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    const bindings: StoredProfileBinding[] = isV1
      ? (parsedBindings as StoredProfileBindingV1[]).map((entry) => ({
          profilePath: entry.profilePath,
          binding: {
            tenantId: entry.binding.tenantId,
            ownerScope: "USER",
            ownerId: entry.binding.ownerId,
            deviceInstallationId: entry.binding.installationId,
            agentInstallationId: null,
            runtimeProfileId: entry.binding.runtimeProfileId,
            boundAt: entry.binding.boundAt,
          },
        }))
      : (parsedBindings as StoredProfileBinding[]);
    const freshProfileOperations =
      parsedOperations as FreshProfileReservation[];
    if (
      new Set(bindings.map((entry) => entry.profilePath)).size !==
        bindings.length ||
      new Set(bindings.map((entry) => entry.binding.runtimeProfileId)).size !==
        bindings.length ||
      new Set(
        bindings
          .map((entry) => entry.binding.agentInstallationId)
          .filter((value): value is string => value !== null),
      ).size !==
        bindings.filter((entry) => entry.binding.agentInstallationId !== null)
          .length ||
      new Set(freshProfileOperations.map((operation) => operation.operationId))
        .size !== freshProfileOperations.length ||
      new Set(freshProfileOperations.map((operation) => operation.profileId))
        .size !== freshProfileOperations.length ||
      new Set(
        freshProfileOperations.map((operation) => operation.runtimeProfileId),
      ).size !== freshProfileOperations.length ||
      freshProfileOperations.some((operation) => {
        const matchingBinding = bindings.find(
          (entry) =>
            entry.binding.runtimeProfileId === operation.runtimeProfileId,
        );
        return (
          matchingBinding !== undefined &&
          !sameOwner(matchingBinding.binding, {
            tenantId: operation.tenantId,
            ownerId: operation.ownerId,
            deviceInstallationId: operation.deviceInstallationId,
          })
        );
      })
    ) {
      throw new Error("Aera Runtime Profile binding store is corrupt.");
    }
    const result: RuntimeProfileBindingStateV3 = {
      bindings: bindings.map((entry) => ({
        profilePath: entry.profilePath,
        binding: { ...entry.binding },
      })),
      freshProfileOperations: freshProfileOperations.map((operation) => ({
        ...operation,
      })),
    };
    if (candidate.version !== PROFILE_BINDING_VERSION) {
      this.persistState(result);
    }
    return result;
  }

  private persistBindings(bindings: StoredProfileBinding[]): void {
    const state = this.readState();
    state.bindings = bindings.map((entry) => ({
      profilePath: entry.profilePath,
      binding: { ...entry.binding },
    }));
    this.persistState(state);
  }

  private persistState(state: RuntimeProfileBindingStateV3): void {
    this.requireEncryption();
    const encrypted = this.secureStorage.encryptString(
      JSON.stringify({
        bindings: state.bindings,
        freshProfileOperations: state.freshProfileOperations,
      } satisfies RuntimeProfileBindingStateV3),
    );
    const envelope: BindingEnvelope = {
      schema: PROFILE_BINDING_SCHEMA,
      version: PROFILE_BINDING_VERSION,
      encryptedBindings: encrypted.toString("base64"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  private requireEncryption(): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error(
        "Aera secure storage is unavailable for Runtime ownership metadata.",
      );
    }
  }
}
