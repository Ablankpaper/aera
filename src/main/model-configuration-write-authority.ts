import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";

export type ManagedModelFileRole =
  | "env"
  | "providers"
  | "models"
  | "modelDefinitions"
  | "config";

export interface ManagedModelFileRoots {
  globalRoot: string;
  profiles: Record<string, string>;
}

export interface ManagedWriteScope {
  globalCatalog: boolean;
  profileIds: readonly string[];
}

declare const permitBrand: unique symbol;

export interface ModelConfigurationWritePermit {
  readonly [permitBrand]: true;
  readonly operationId: string;
  readonly globalCatalog: boolean;
  readonly profileIds: readonly string[];
}

export type ModelConfigurationWriteErrorCode =
  | "model_configuration_lock_order_violation"
  | "model_configuration_write_permit_required"
  | "model_configuration_write_scope_denied";

export class ModelConfigurationWriteError extends Error {
  readonly code: ModelConfigurationWriteErrorCode;

  constructor(code: ModelConfigurationWriteErrorCode, message: string) {
    super(message);
    this.name = "ModelConfigurationWriteError";
    this.code = code;
  }
}

interface ActivePermit extends ModelConfigurationWritePermit {
  active: boolean;
}

const activePermits = new WeakSet<object>();
const permitStorage = new AsyncLocalStorage<ActivePermit>();
let operationSequence = 0;

let registeredRoots: {
  globalRoot: string;
  profiles: Map<string, string>;
} | null = null;

function normalizedPath(path: string): string {
  return resolve(path);
}

export function registerManagedModelFileRoots(
  roots: ManagedModelFileRoots,
): void {
  if (!isAbsolute(roots.globalRoot)) {
    throw new TypeError("Managed model global root must be absolute.");
  }
  const profiles = new Map<string, string>();
  for (const [profileId, profileRoot] of Object.entries(roots.profiles)) {
    if (!isAbsolute(profileRoot) || !profileId.trim()) {
      throw new TypeError("Managed model Profile root is invalid.");
    }
    profiles.set(profileId.trim(), normalizedPath(profileRoot));
  }
  registeredRoots = {
    globalRoot: normalizedPath(roots.globalRoot),
    profiles,
  };
}

export function clearManagedModelFileRoots(): void {
  registeredRoots = null;
}

export interface ManagedModelFileLocation {
  role: ManagedModelFileRole;
  profileId: string | null;
}

export function managedModelFileLocation(
  path: string,
): ManagedModelFileLocation | null {
  if (!registeredRoots) return null;
  const target = normalizedPath(path);
  if (target === resolve(registeredRoots.globalRoot, "models.json")) {
    return { role: "models", profileId: null };
  }
  if (
    target === resolve(registeredRoots.globalRoot, "model-definitions.json")
  ) {
    return { role: "modelDefinitions", profileId: null };
  }
  for (const [profileId, profileRoot] of registeredRoots.profiles) {
    if (target === resolve(profileRoot, ".env")) {
      return { role: "env", profileId };
    }
    if (target === resolve(profileRoot, "providers.json")) {
      return { role: "providers", profileId };
    }
    if (target === resolve(profileRoot, "config.yaml")) {
      return { role: "config", profileId };
    }
  }
  return null;
}

function assertPermitObject(
  permit: ModelConfigurationWritePermit | null | undefined,
): asserts permit is ActivePermit {
  const current = permitStorage.getStore();
  if (!permit || !current || permit !== current || !current.active) {
    throw new ModelConfigurationWriteError(
      "model_configuration_write_permit_required",
      "A managed model-file write requires an active coordinator permit.",
    );
  }
  if (!activePermits.has(permit)) {
    throw new ModelConfigurationWriteError(
      "model_configuration_write_permit_required",
      "The managed model-file write permit is no longer active.",
    );
  }
}

export function currentModelConfigurationWritePermit():
  | ModelConfigurationWritePermit
  | null {
  const current = permitStorage.getStore();
  return current && current.active && activePermits.has(current) ? current : null;
}

export function assertManagedWritePath(
  path: string,
  permit: ModelConfigurationWritePermit | null | undefined =
    currentModelConfigurationWritePermit(),
): void {
  const location = managedModelFileLocation(path);
  if (!location) return;
  assertPermitObject(permit);
  const allowed =
    location.profileId === null
      ? permit.globalCatalog
      : permit.profileIds.includes(location.profileId);
  if (!allowed) {
    throw new ModelConfigurationWriteError(
      "model_configuration_write_scope_denied",
      `The active permit cannot write managed model role ${location.role}.`,
    );
  }
}

function validateScope(scope: ManagedWriteScope): {
  globalCatalog: boolean;
  profileIds: string[];
} {
  if (!scope || typeof scope.globalCatalog !== "boolean") {
    throw new TypeError("Invalid managed model write scope.");
  }
  return {
    globalCatalog: scope.globalCatalog,
    profileIds: [...new Set(scope.profileIds.map((id) => id.trim()))]
      .filter(Boolean)
      .sort(),
  };
}

export class ModelConfigurationWriteAuthority {
  private readonly tails = new Map<string, Promise<void>>();

  private async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  async run<T>(
    scope: ManagedWriteScope,
    callback: (permit: ModelConfigurationWritePermit) => T | Promise<T>,
  ): Promise<T> {
    if (permitStorage.getStore()) {
      throw new ModelConfigurationWriteError(
        "model_configuration_lock_order_violation",
        "Managed model write scopes cannot be nested.",
      );
    }
    const normalized = validateScope(scope);
    const keys = [
      "global:model-catalog",
      ...normalized.profileIds.map((id) => `profile:${id}`),
    ];
    const releases: Array<() => void> = [];
    for (const key of keys) releases.push(await this.acquire(key));
    const permit = {
      operationId: `managed-${Date.now().toString(36)}-${(++operationSequence).toString(36)}`,
      globalCatalog: normalized.globalCatalog,
      profileIds: Object.freeze(normalized.profileIds.slice()),
      active: true,
    } as ActivePermit;
    activePermits.add(permit);
    try {
      return await permitStorage.run(permit, () => callback(permit));
    } finally {
      permit.active = false;
      activePermits.delete(permit);
      for (const release of releases.reverse()) release();
    }
  }
}

export const defaultModelConfigurationWriteAuthority =
  new ModelConfigurationWriteAuthority();
