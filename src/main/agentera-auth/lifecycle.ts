import { createHash, randomBytes } from "node:crypto";
import { signAgenteraDeviceDigest } from "./device-key";
import type { InstallationIdentity, PendingSelfRevocation } from "./store";

const ONLINE_REFRESH_MS = 15 * 60 * 1000;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 5 * 60 * 1000;

type TimerHandle = unknown;

export interface AgenteraAuthLifecycleOptions {
  validateOnline: () => Promise<void>;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class AgenteraAuthLifecycle {
  private readonly validateOnline: () => Promise<void>;
  private readonly random: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private timer: TimerHandle | null = null;
  private retryAttempt = 0;
  private disposed = false;

  constructor(options: AgenteraAuthLifecycleOptions) {
    this.validateOnline = options.validateOnline;
    this.random = options.random ?? Math.random;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  noteOnlineValidationSucceeded(): void {
    if (this.disposed) return;
    this.retryAttempt = 0;
    this.schedule(ONLINE_REFRESH_MS);
  }

  noteControlPlaneUnavailable(): void {
    if (this.disposed) return;
    const base = Math.min(
      RETRY_MAX_MS,
      RETRY_INITIAL_MS * 2 ** Math.min(this.retryAttempt, 18),
    );
    this.retryAttempt += 1;
    const random = Math.min(1, Math.max(0, this.random()));
    const jitter = 0.75 + random * 0.5;
    this.schedule(Math.min(RETRY_MAX_MS, Math.round(base * jitter)));
  }

  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.retryAttempt = 0;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.validateOnline().catch(() => {
        this.noteControlPlaneUnavailable();
      });
    }, delayMs);
  }
}

export interface CreatePendingAgenteraSelfRevocationOptions {
  deviceId: string;
  identity: InstallationIdentity;
  now?: Date;
  nonce?: Uint8Array;
}

function selfRevocationDigest(
  deviceId: string,
  installationId: string,
  timestamp: string,
  nonce: Buffer,
): Buffer {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from(
          `agentera-self-revoke\0${deviceId}\0${installationId}\0${timestamp}\0`,
          "utf8",
        ),
        nonce,
      ]),
    )
    .digest();
}

export function createPendingAgenteraSelfRevocation(
  options: CreatePendingAgenteraSelfRevocationOptions,
): PendingSelfRevocation {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Aera self-revocation time is invalid.");
  }
  const nonce = options.nonce ? Buffer.from(options.nonce) : randomBytes(32);
  if (nonce.length !== 32) {
    throw new Error("Aera self-revocation nonce is invalid.");
  }
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const digest = selfRevocationDigest(
    options.deviceId,
    options.identity.installationId,
    timestamp,
    nonce,
  );
  return {
    deviceId: options.deviceId,
    installationId: options.identity.installationId,
    timestamp,
    nonce: nonce.toString("base64url"),
    signature: signAgenteraDeviceDigest(
      options.identity.devicePrivateKey,
      digest,
    ),
  };
}

/** Re-sign an encrypted pending intent with a fresh server-acceptable time. */
export function refreshPendingAgenteraSelfRevocation(
  pending: PendingSelfRevocation,
  identity: InstallationIdentity,
  now: Date = new Date(),
): PendingSelfRevocation {
  const nonce = Buffer.from(pending.nonce, "base64url");
  if (
    nonce.length !== 32 ||
    nonce.toString("base64url") !== pending.nonce ||
    pending.installationId !== identity.installationId
  ) {
    throw new Error("Aera pending self-revocation is invalid.");
  }
  return createPendingAgenteraSelfRevocation({
    deviceId: pending.deviceId,
    identity,
    now,
    nonce,
  });
}
