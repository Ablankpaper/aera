import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SecureStorageAdapter } from "./agentera-auth/store";
import type { AgenteraRuntimeOwner } from "./agentera-profile-binding";
import { safeWriteFile } from "./utils";

const CONNECTION_OWNER_SCHEMA = "agentera-connection-owners" as const;
const CONNECTION_OWNER_VERSION_V1 = 1 as const;
const CONNECTION_OWNER_VERSION = 2 as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConnectionOwnerBinding extends AgenteraRuntimeOwner {
  connectionContextId: string;
  ownerScope: "USER";
  boundAt: string;
}

interface ConnectionOwnerEnvelope {
  schema: typeof CONNECTION_OWNER_SCHEMA;
  version: typeof CONNECTION_OWNER_VERSION;
  encryptedBindings: string;
}

interface ConnectionOwnerEnvelopeV1 {
  schema: typeof CONNECTION_OWNER_SCHEMA;
  version: typeof CONNECTION_OWNER_VERSION_V1;
  encryptedBindings: string;
}

interface ConnectionOwnerBindingV1 {
  connectionContextId: string;
  tenantId: string;
  ownerScope: "USER";
  ownerId: string;
  installationId: string;
  boundAt: string;
}

export interface ConnectionOwnerStoreOptions {
  userDataPath: string;
  secureStorage: SecureStorageAdapter;
  writeFile?: (path: string, content: string) => void;
  now?: () => Date;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function exactKeys(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function assertOwner(owner: AgenteraRuntimeOwner): void {
  if (
    !validUuid(owner.tenantId) ||
    !validUuid(owner.ownerId) ||
    !validUuid(owner.deviceInstallationId)
  ) {
    throw new Error("Aera connection owner identity is invalid.");
  }
}

function validBinding(value: unknown): value is ConnectionOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ConnectionOwnerBinding>;
  return (
    exactKeys(value, [
      "connectionContextId",
      "tenantId",
      "ownerScope",
      "ownerId",
      "deviceInstallationId",
      "boundAt",
    ]) &&
    validUuid(record.connectionContextId) &&
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.deviceInstallationId) &&
    validIsoDate(record.boundAt)
  );
}

function validBindingV1(value: unknown): value is ConnectionOwnerBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ConnectionOwnerBindingV1>;
  return (
    exactKeys(value, [
      "connectionContextId",
      "tenantId",
      "ownerScope",
      "ownerId",
      "installationId",
      "boundAt",
    ]) &&
    validUuid(record.connectionContextId) &&
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.installationId) &&
    validIsoDate(record.boundAt)
  );
}

function sameOwner(
  binding: ConnectionOwnerBinding,
  owner: AgenteraRuntimeOwner,
): boolean {
  return (
    binding.tenantId === owner.tenantId &&
    binding.ownerId === owner.ownerId &&
    binding.deviceInstallationId === owner.deviceInstallationId
  );
}

export class AgenteraConnectionOwnerStore {
  readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private readonly writeFile: (path: string, content: string) => void;
  private readonly now: () => Date;

  constructor(options: ConnectionOwnerStoreOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Electron userData path must be absolute.");
    }
    this.filePath = join(
      resolve(options.userDataPath),
      "agentera-auth",
      "connection-owners.json",
    );
    this.secureStorage = options.secureStorage;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.now = options.now ?? (() => new Date());
  }

  inspectConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ):
    | { status: "unbound" }
    | {
        status: "owned";
        isCurrentOwner: boolean;
        binding: ConnectionOwnerBinding;
      } {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const binding = this.readBindings().find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (!binding) return { status: "unbound" };
    return {
      status: "owned",
      isCurrentOwner: sameOwner(binding, owner),
      binding: { ...binding },
    };
  }

  bindConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ): ConnectionOwnerBinding {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const bindings = this.readBindings();
    const existing = bindings.find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (existing) {
      if (sameOwner(existing, owner)) return { ...existing };
      throw new Error(
        "This connection context cannot be reassigned to another Aera owner.",
      );
    }
    const binding: ConnectionOwnerBinding = {
      connectionContextId,
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      boundAt: this.now().toISOString(),
    };
    bindings.push(binding);
    this.persistBindings(bindings);
    return { ...binding };
  }

  verifyConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ): ConnectionOwnerBinding {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const binding = this.readBindings().find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (!binding) {
      throw new Error("Aera connection context binding is required.");
    }
    if (!sameOwner(binding, owner)) {
      throw new Error("This connection context belongs to another Aera owner.");
    }
    return { ...binding };
  }

  private assertContext(connectionContextId: string): void {
    if (!validUuid(connectionContextId)) {
      throw new Error("Aera connection context ID is invalid.");
    }
  }

  private readBindings(): ConnectionOwnerBinding[] {
    if (!existsSync(this.filePath)) return [];
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    const candidate = envelope as Partial<
      ConnectionOwnerEnvelope | ConnectionOwnerEnvelopeV1
    >;
    if (
      !exactKeys(envelope, ["schema", "version", "encryptedBindings"]) ||
      candidate.schema !== CONNECTION_OWNER_SCHEMA ||
      (candidate.version !== CONNECTION_OWNER_VERSION_V1 &&
        candidate.version !== CONNECTION_OWNER_VERSION) ||
      typeof candidate.encryptedBindings !== "string"
    ) {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    this.requireEncryption();
    let parsed: unknown;
    try {
      const decrypted = this.secureStorage.decryptString(
        Buffer.from(candidate.encryptedBindings, "base64"),
      );
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    const isV1 = candidate.version === CONNECTION_OWNER_VERSION_V1;
    if (
      !Array.isArray(parsed) ||
      parsed.some((binding) =>
        isV1 ? !validBindingV1(binding) : !validBinding(binding),
      )
    ) {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    const bindings: ConnectionOwnerBinding[] = isV1
      ? (parsed as ConnectionOwnerBindingV1[]).map((binding) => ({
          connectionContextId: binding.connectionContextId,
          tenantId: binding.tenantId,
          ownerScope: "USER",
          ownerId: binding.ownerId,
          deviceInstallationId: binding.installationId,
          boundAt: binding.boundAt,
        }))
      : (parsed as ConnectionOwnerBinding[]);
    if (
      new Set(bindings.map((binding) => binding.connectionContextId)).size !==
      bindings.length
    ) {
      throw new Error("Aera connection ownership store is corrupt.");
    }
    const result = bindings.map((binding) => ({ ...binding }));
    if (isV1) this.persistBindings(result);
    return result;
  }

  private persistBindings(bindings: ConnectionOwnerBinding[]): void {
    this.requireEncryption();
    const encrypted = this.secureStorage.encryptString(
      JSON.stringify(bindings),
    );
    const envelope: ConnectionOwnerEnvelope = {
      schema: CONNECTION_OWNER_SCHEMA,
      version: CONNECTION_OWNER_VERSION,
      encryptedBindings: encrypted.toString("base64"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  private requireEncryption(): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error(
        "Aera secure storage is unavailable for connection ownership metadata.",
      );
    }
  }
}

export type AgenteraOwnerTransitionErrorCode =
  | "model_owner_transition_in_progress"
  | "model_owner_changed"
  | "owner_transition_timeout"
  | "owner_transition_failed";

/**
 * Stable, Main-only failure raised when owner-scoped work cannot safely run.
 * The error deliberately carries no owner id, path, or cleanup exception.
 */
export class AgenteraOwnerTransitionError extends Error {
  readonly code: AgenteraOwnerTransitionErrorCode;
  readonly diagnosticId: string | null;

  constructor(
    code: AgenteraOwnerTransitionErrorCode,
    diagnosticId: string | null = null,
  ) {
    super(`Aera owner transition failed: ${code}.`);
    this.name = "AgenteraOwnerTransitionError";
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

export interface AgenteraOwnerEpochLease {
  readonly epoch: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface AgenteraOwnerTransitionResult {
  readonly epoch: number;
  readonly state: "ready" | "unmounted";
  readonly diagnosticId: string;
}

export interface AgenteraOwnerTransitionEvent {
  readonly phase: "begin" | "ready" | "unmounted" | "timeout" | "failed";
  readonly epoch: number;
  readonly diagnosticId: string;
}

export interface AgenteraOwnerStopContext {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly epoch: number;
  readonly diagnosticId: string;
}

export interface AgenteraOwnerSwitchCoordinator {
  transitionTo(ownerId: string | null): Promise<AgenteraOwnerTransitionResult>;
  acquireLease(): Promise<AgenteraOwnerEpochLease>;
  snapshot(): Readonly<{
    epoch: number;
    state: "ready" | "transitioning" | "blocked" | "unmounted";
    diagnosticId: string | null;
  }>;
}

export interface AgenteraOwnerSwitchCoordinatorOptions {
  stopRuntimeContext: (
    context: AgenteraOwnerStopContext,
  ) => void | Promise<void>;
  timeoutMs?: number;
  onEvent?: (event: AgenteraOwnerTransitionEvent) => void;
}

const DEFAULT_OWNER_TRANSITION_TIMEOUT_MS = 15_000;

function transitionDiagnosticId(): string {
  return randomBytes(6).toString("hex");
}

function emitTransitionEvent(
  callback: ((event: AgenteraOwnerTransitionEvent) => void) | undefined,
  event: AgenteraOwnerTransitionEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Observability must never change the owner safety decision.
  }
}

/**
 * Serializes owner transitions and exposes a single epoch lease for every
 * owner-scoped operation. The requested owner is not observable outside Main;
 * it is installed only after the previous Runtime context has fully drained.
 */
export function createAgenteraOwnerSwitchCoordinator(
  options: AgenteraOwnerSwitchCoordinatorOptions,
): AgenteraOwnerSwitchCoordinator {
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_OWNER_TRANSITION_TIMEOUT_MS),
  );
  let activeOwnerId: string | null = null;
  let epoch = 0;
  let state: "ready" | "transitioning" | "blocked" | "unmounted" = "unmounted";
  let diagnosticId: string | null = null;
  let activeController = new AbortController();
  let queue: Promise<void> = Promise.resolve();
  let pendingTransitions = 0;
  let blockedErrorCode:
    | "owner_transition_timeout"
    | "owner_transition_failed"
    | null = null;

  const snapshot = (): Readonly<{
    epoch: number;
    state: "ready" | "transitioning" | "blocked" | "unmounted";
    diagnosticId: string | null;
  }> => Object.freeze({ epoch, state, diagnosticId });

  interface PendingTransition {
    requestedOwnerId: string | null;
    epoch: number;
    diagnosticId: string;
    hadMountedContext: boolean;
  }

  const beginTransition = (
    requestedOwnerId: string | null,
  ): PendingTransition => {
    const hadMountedContext = activeOwnerId !== null || state === "blocked";
    epoch += 1;
    const transitionEpoch = epoch;
    const transitionId = transitionDiagnosticId();
    diagnosticId = transitionId;
    state = "transitioning";
    blockedErrorCode = null;
    activeController.abort();
    activeController = new AbortController();
    emitTransitionEvent(options.onEvent, {
      phase: "begin",
      epoch: transitionEpoch,
      diagnosticId: transitionId,
    });
    return {
      requestedOwnerId,
      epoch: transitionEpoch,
      diagnosticId: transitionId,
      hadMountedContext,
    };
  };

  const completeTransition = async (
    pending: PendingTransition,
  ): Promise<AgenteraOwnerTransitionResult> => {
    const {
      requestedOwnerId,
      epoch: transitionEpoch,
      diagnosticId: transitionId,
      hadMountedContext,
    } = pending;

    // A transition from the initial unmounted state has no old resources to
    // drain. A blocked state, however, always retries the drain and remains
    // fail-closed until that retry succeeds.
    if (hadMountedContext) {
      const stopController = new AbortController();
      const context: AgenteraOwnerStopContext = {
        signal: stopController.signal,
        deadlineMs: timeoutMs,
        epoch: transitionEpoch,
        diagnosticId: transitionId,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanup: Promise<void>;
      try {
        cleanup = Promise.resolve(options.stopRuntimeContext(context));
      } catch (error) {
        cleanup = Promise.reject(error);
      }
      cleanup.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AgenteraOwnerTransitionError(
                "owner_transition_timeout",
                transitionId,
              ),
            ),
          timeoutMs,
        );
      });
      try {
        await Promise.race([cleanup, timeout]);
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        stopController.abort();
        activeOwnerId = null;
        state = "blocked";
        const transitionError =
          error instanceof AgenteraOwnerTransitionError &&
          error.code === "owner_transition_timeout"
            ? error
            : new AgenteraOwnerTransitionError(
                "owner_transition_failed",
                transitionId,
              );
        blockedErrorCode =
          transitionError.code === "owner_transition_timeout"
            ? "owner_transition_timeout"
            : "owner_transition_failed";
        emitTransitionEvent(options.onEvent, {
          phase:
            transitionError.code === "owner_transition_timeout"
              ? "timeout"
              : "failed",
          epoch: transitionEpoch,
          diagnosticId: transitionId,
        });
        throw transitionError;
      }
      if (timer !== undefined) clearTimeout(timer);
    }

    activeOwnerId = requestedOwnerId;
    // A new lease is not observable until teardown has completed. Keeping the
    // old controller aborted during the drain also makes accidental use fail
    // closed even if a caller ignores the transition Promise.
    activeController = new AbortController();
    blockedErrorCode = null;
    state = requestedOwnerId === null ? "unmounted" : "ready";
    emitTransitionEvent(options.onEvent, {
      phase: requestedOwnerId === null ? "unmounted" : "ready",
      epoch: transitionEpoch,
      diagnosticId: transitionId,
    });
    return Object.freeze({
      epoch: transitionEpoch,
      state: state === "ready" ? ("ready" as const) : ("unmounted" as const),
      diagnosticId: transitionId,
    });
  };

  const transitionTo = (
    requestedOwnerId: string | null,
  ): Promise<AgenteraOwnerTransitionResult> => {
    const isNoop =
      (state === "ready" && activeOwnerId === requestedOwnerId) ||
      (state === "unmounted" && requestedOwnerId === null);
    if (pendingTransitions === 0 && isNoop) {
      const id = diagnosticId ?? transitionDiagnosticId();
      diagnosticId = id;
      return Promise.resolve(
        Object.freeze({
          epoch,
          state:
            state === "ready" ? ("ready" as const) : ("unmounted" as const),
          diagnosticId: id,
        }),
      );
    }

    pendingTransitions += 1;
    const runTransition = async (): Promise<AgenteraOwnerTransitionResult> => {
      // Re-check after waiting in the queue. A duplicate auth notification can
      // arrive while an earlier transition is draining; it must not tear down
      // the freshly mounted owner a second time.
      const queuedNoop =
        (state === "ready" && activeOwnerId === requestedOwnerId) ||
        (state === "unmounted" && requestedOwnerId === null);
      if (queuedNoop) {
        const id = diagnosticId ?? transitionDiagnosticId();
        diagnosticId = id;
        return Object.freeze({
          epoch,
          state:
            state === "ready" ? ("ready" as const) : ("unmounted" as const),
          diagnosticId: id,
        });
      }
      const pending = beginTransition(requestedOwnerId);
      return completeTransition(pending);
    };

    // Begin synchronously for the first transition so the old epoch is
    // invalidated before the caller can start another owner-scoped operation.
    // Later transitions are chained to the current tail and cannot overlap.
    const next =
      pendingTransitions === 1
        ? runTransition()
        : queue.then(() => runTransition());
    const tracked = next.then(
      (result) => {
        pendingTransitions -= 1;
        return result;
      },
      (error) => {
        pendingTransitions -= 1;
        throw error;
      },
    );
    // Keep the queue alive after a failed transition so a caller can inspect
    // the blocked state or explicitly retry with a later transition.
    queue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  };

  const acquireLease = async (): Promise<AgenteraOwnerEpochLease> => {
    await queue;
    if (state !== "ready" || activeOwnerId === null) {
      throw new AgenteraOwnerTransitionError(
        state === "blocked"
          ? (blockedErrorCode ?? "owner_transition_timeout")
          : "model_owner_transition_in_progress",
        diagnosticId,
      );
    }
    const leaseEpoch = epoch;
    const leaseController = activeController;
    return {
      epoch: leaseEpoch,
      signal: leaseController.signal,
      assertCurrent(): void {
        if (
          state !== "ready" ||
          epoch !== leaseEpoch ||
          leaseController.signal.aborted
        ) {
          throw new AgenteraOwnerTransitionError(
            state === "ready" && epoch !== leaseEpoch
              ? "model_owner_changed"
              : state === "blocked"
                ? (blockedErrorCode ?? "owner_transition_timeout")
                : "model_owner_transition_in_progress",
            diagnosticId,
          );
        }
      },
    };
  };

  return {
    transitionTo,
    acquireLease,
    snapshot,
  };
}
