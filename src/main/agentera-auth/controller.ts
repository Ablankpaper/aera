import type {
  AgenteraAuthPublicState,
  AgenteraPortalTarget,
} from "../../shared/agentera-auth";
import { serializeAgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraCloudClientPort,
  AgenteraDeviceMetadata,
  AgenteraTokenSet,
} from "./client";
import { AgenteraCloudClientError } from "./client";
import {
  getAgenteraRechargePublicUrl,
  getBundledAgenteraOfflinePublicKeys,
} from "./config";
import { getOrCreateAgenteraDeviceIdentity } from "./device-key";
import {
  AgenteraOfflineEntitlementError,
  verifyAgenteraOfflineEntitlement,
  type AgenteraOfflineEntitlementClaims,
} from "./entitlement";
import {
  AgenteraAuthLifecycle,
  createPendingAgenteraSelfRevocation,
  refreshPendingAgenteraSelfRevocation,
  type AgenteraAuthLifecycleOptions,
} from "./lifecycle";
import type {
  AgenteraLoopbackListener,
  AgenteraLoopbackOptions,
} from "./loopback";
import { startAgenteraLoopbackListener } from "./loopback";
import type { AgenteraPkceAttempt } from "./pkce";
import { createAgenteraPkceAttempt } from "./pkce";
import type {
  AgenteraAuthStore,
  PendingSelfRevocation,
  ProductSession,
} from "./store";
import { AgenteraTrustedTimeAnchor } from "./time-anchor";

const AGENTERA_OFFLINE_AUDIENCE = "agentera-studio";

export interface AgenteraAuthController {
  initialize(): Promise<AgenteraAuthPublicState>;
  getPublicState(): AgenteraAuthPublicState;
  /** Main-process-only bearer access; never expose this method through IPC. */
  getAccessTokenForCloudRequest(): string | null;
  startBrowserLogin(options?: {
    forceAccountSelection?: boolean;
  }): Promise<void>;
  cancelBrowserLogin(): Promise<void>;
  refreshOnline(): Promise<AgenteraAuthPublicState>;
  assertCanStartNewTask(): void;
  openPortal(target: AgenteraPortalTarget): Promise<void>;
  logout(): Promise<void>;
  subscribe(listener: (state: AgenteraAuthPublicState) => void): () => void;
}

export interface AgenteraAuthControllerRuntime {
  store: AgenteraAuthStore;
  getCloudClient: () => AgenteraCloudClientPort;
  createPkce?: () => AgenteraPkceAttempt;
  startLoopback?: (
    options: AgenteraLoopbackOptions,
  ) => Promise<AgenteraLoopbackListener>;
  openExternal: (url: string, expectedOrigin: string) => void | Promise<void>;
  bringMainWindowToFront: () => void;
  getDeviceMetadata: () => AgenteraDeviceMetadata;
  offlinePublicKeys?: Readonly<Record<string, string>>;
  wallNow?: () => number;
  monotonicNow?: () => number;
  lifecycle?: Omit<AgenteraAuthLifecycleOptions, "validateOnline">;
  onProductAccessLost?: () => void;
  openTrustedExternal?: (url: string) => void | Promise<void>;
  getRechargePublicUrl?: () => string | null;
}

interface ActiveAttempt {
  cancelled: boolean;
  listener: AgenteraLoopbackListener | null;
}

type PendingDelivery = "none" | "delivered" | "pending";

function hasProductAccess(state: AgenteraAuthPublicState): boolean {
  return state.status === "authenticated" || state.status === "offline";
}

function isControlPlaneUnavailable(error: unknown): boolean {
  return (
    error instanceof AgenteraCloudClientError &&
    (error.code === "network_unavailable" || error.status >= 500)
  );
}

function revokedReason(
  error: AgenteraCloudClientError,
): Extract<AgenteraAuthPublicState, { status: "blocked" }>["reason"] {
  if (error.code === "account_disabled") return "account_disabled";
  if (error.code === "account_pending_deletion") {
    return "account_pending_deletion";
  }
  return "device_revoked";
}

export class AgenteraAuthControllerImpl implements AgenteraAuthController {
  private state: AgenteraAuthPublicState = { status: "checking" };
  private readonly listeners = new Set<
    (state: AgenteraAuthPublicState) => void
  >();
  private readonly runtime: Required<
    Pick<AgenteraAuthControllerRuntime, "createPkce" | "startLoopback">
  > &
    Omit<AgenteraAuthControllerRuntime, "createPkce" | "startLoopback">;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly lifecycle: AgenteraAuthLifecycle;
  private activeAttempt: ActiveAttempt | null = null;
  private accessToken: string | null = null;
  private entitlement: AgenteraOfflineEntitlementClaims | null = null;
  private timeAnchor: AgenteraTrustedTimeAnchor | null = null;
  private refreshInFlight: Promise<AgenteraAuthPublicState> | null = null;
  private sessionRevision = 0;

  constructor(runtime: AgenteraAuthControllerRuntime) {
    this.runtime = {
      ...runtime,
      createPkce: runtime.createPkce ?? createAgenteraPkceAttempt,
      startLoopback: runtime.startLoopback ?? startAgenteraLoopbackListener,
    };
    this.wallNow = runtime.wallNow ?? Date.now;
    this.monotonicNow = runtime.monotonicNow ?? (() => performance.now());
    this.lifecycle = new AgenteraAuthLifecycle({
      ...runtime.lifecycle,
      validateOnline: async () => {
        await this.refreshOnline();
      },
    });
  }

  async initialize(): Promise<AgenteraAuthPublicState> {
    try {
      return await this.refreshOnline();
    } catch (error) {
      return this.publishSecureFailure(error);
    }
  }

  getPublicState(): AgenteraAuthPublicState {
    return serializeAgenteraAuthPublicState(this.state);
  }

  /** Main-process-only bearer access for later cloud calls; never wired to IPC. */
  getAccessTokenForCloudRequest(): string | null {
    return this.accessToken;
  }

  async startBrowserLogin(
    options: {
      forceAccountSelection?: boolean;
    } = {},
  ): Promise<void> {
    if (this.activeAttempt) {
      throw new Error("AgentEra browser authorization is already in progress.");
    }
    if (
      this.runtime.store.getPendingRevocation() &&
      (await this.deliverPendingRevocation()) === "pending"
    ) {
      throw new Error(
        "AgentEra must finish the previous device sign-out before signing in again.",
      );
    }

    const attempt: ActiveAttempt = { cancelled: false, listener: null };
    this.activeAttempt = attempt;
    this.sessionRevision += 1;
    this.lifecycle.cancel();
    this.publish({ status: "checking" });

    try {
      const identity = getOrCreateAgenteraDeviceIdentity(this.runtime.store);
      const pkce = this.runtime.createPkce();
      const listener = await this.runtime.startLoopback({
        expectedState: pkce.state,
      });
      attempt.listener = listener;
      if (attempt.cancelled) {
        void listener.callback.catch(() => undefined);
        listener.cancel();
        throw new Error("AgentEra browser authorization was cancelled.");
      }

      const client = this.runtime.getCloudClient();
      const authorizationUrl = client.createAuthorizationUrl({
        redirectUri: listener.redirectUri,
        pkce,
        identity,
        ...this.runtime.getDeviceMetadata(),
        forceAccountSelection: options.forceAccountSelection === true,
      });
      await this.runtime.openExternal(authorizationUrl.href, client.origin);
      const callback = await listener.callback;
      if (attempt.cancelled) {
        throw new Error("AgentEra browser authorization was cancelled.");
      }
      this.runtime.bringMainWindowToFront();
      const tokens = await client.exchangeAuthorizationCode({
        authorizationCode: callback.authorizationCode,
        codeVerifier: pkce.verifier,
        identity,
      });
      if (attempt.cancelled) {
        throw new Error("AgentEra browser authorization was cancelled.");
      }
      this.acceptOnlineTokens(tokens, client);
      this.lifecycle.noteOnlineValidationSucceeded();
      this.publish(this.authenticatedState(tokens));
    } catch (error) {
      this.clearInMemoryAuthorization();
      if (/secure storage/i.test(String(error))) {
        this.publish({
          status: "blocked",
          reason: "secure_storage_unavailable",
        });
      } else {
        this.publish({
          status: "unauthenticated",
          reason: "sign_in_required",
        });
      }
      throw error;
    } finally {
      attempt.listener?.close();
      if (this.activeAttempt === attempt) this.activeAttempt = null;
    }
  }

  async cancelBrowserLogin(): Promise<void> {
    const attempt = this.activeAttempt;
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.listener?.cancel();
  }

  async refreshOnline(): Promise<AgenteraAuthPublicState> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.performOnlineRefresh();
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    }
  }

  private async performOnlineRefresh(): Promise<AgenteraAuthPublicState> {
    const revision = this.sessionRevision;
    let pending: PendingDelivery;
    let stored: ProductSession | null;
    try {
      pending = await this.deliverPendingRevocation();
      stored = this.runtime.store.getProductSession();
    } catch (error) {
      return this.publishSecureFailure(error);
    }
    if (!stored) {
      this.clearInMemoryAuthorization();
      if (pending !== "pending") this.lifecycle.cancel();
      return this.publish({
        status: "unauthenticated",
        reason: "sign_in_required",
      });
    }

    let client: AgenteraCloudClientPort | null = null;
    try {
      client = this.runtime.getCloudClient();
      const tokens = await client.refreshSession(stored.refreshToken);
      if (revision !== this.sessionRevision) return this.getPublicState();
      if (
        tokens.userId !== stored.userId ||
        tokens.personalSpaceId !== stored.personalSpaceId ||
        tokens.deviceId !== stored.deviceId
      ) {
        throw new AgenteraCloudClientError(0, "session_binding_changed");
      }
      this.acceptOnlineTokens(tokens, client);
      this.lifecycle.noteOnlineValidationSucceeded();
      return this.publish(this.authenticatedState(tokens));
    } catch (error) {
      if (revision !== this.sessionRevision) return this.getPublicState();
      this.accessToken = null;
      if (
        error instanceof AgenteraCloudClientError &&
        (error.status === 401 ||
          error.code === "account_disabled" ||
          error.code === "account_pending_deletion")
      ) {
        this.runtime.store.clearProductSession();
        this.sessionRevision += 1;
        this.entitlement = null;
        this.timeAnchor = null;
        this.lifecycle.cancel();
        return this.publish({
          status: "blocked",
          reason: revokedReason(error),
        });
      }
      if (isControlPlaneUnavailable(error) && client) {
        const offline = this.enterOfflineMode(stored, client);
        if (offline.status === "offline") {
          this.lifecycle.noteControlPlaneUnavailable();
        } else {
          this.lifecycle.cancel();
        }
        return this.publish(offline);
      }
      this.entitlement = null;
      this.timeAnchor = null;
      this.lifecycle.cancel();
      return this.publish({ status: "blocked", reason: "sign_in_required" });
    }
  }

  /** Re-check the trusted local deadline synchronously at every Runtime edge. */
  assertCanStartNewTask(): void {
    if (!hasProductAccess(this.state)) {
      throw new Error("AgentEra product sign-in is required.");
    }
    if (!this.entitlement || !this.timeAnchor) {
      this.publish({ status: "blocked", reason: "sign_in_required" });
      throw new Error("AgentEra offline access could not be verified.");
    }
    const evaluated = this.timeAnchor.evaluate();
    if (evaluated.rollbackDetected) {
      this.publish({ status: "blocked", reason: "clock_rollback" });
      this.lifecycle.cancel();
      throw new Error(
        "AgentEra offline access requires online clock verification.",
      );
    }
    if (
      evaluated.trustedNow.getTime() >= Date.parse(this.entitlement.expiresAt)
    ) {
      this.publish({ status: "blocked", reason: "offline_expired" });
      this.lifecycle.cancel();
      throw new Error("AgentEra offline access has expired.");
    }
  }

  async openPortal(target: AgenteraPortalTarget): Promise<void> {
    if (!hasProductAccess(this.state)) {
      throw new Error("AgentEra product sign-in is required.");
    }
    const client = this.runtime.getCloudClient();
    let url: string;
    if (target === "account" || target === "devices") {
      url = new URL(`/${target}`, `${client.origin}/`).href;
    } else if (target === "recharge") {
      const configured =
        this.runtime.getRechargePublicUrl?.() ?? getAgenteraRechargePublicUrl();
      if (!configured) {
        throw new Error("AgentEra recharge URL is not configured.");
      }
      url = configured;
    } else {
      throw new Error("AgentEra portal target is invalid.");
    }

    if (this.runtime.openTrustedExternal) {
      await this.runtime.openTrustedExternal(url);
      return;
    }
    await this.runtime.openExternal(url, new URL(url).origin);
  }

  async logout(): Promise<void> {
    this.sessionRevision += 1;
    const attempt = this.activeAttempt;
    if (attempt) {
      attempt.cancelled = true;
      attempt.listener?.cancel();
    }
    let pending = this.runtime.store.getPendingRevocation();
    const stored = this.runtime.store.getProductSession();
    const identity = this.runtime.store.getInstallation();
    if (stored && identity) {
      pending = createPendingAgenteraSelfRevocation({
        deviceId: stored.deviceId,
        identity,
        now: new Date(this.wallNow()),
      });
      // Persist the logout intent before any network I/O, but retain the
      // encrypted session until an online self-revocation attempt completes.
      // If the app exits here, startup sees the intent and clears the session
      // before retrying delivery.
      this.runtime.store.replaceProductSession(stored, pending);
    }

    this.clearInMemoryAuthorization();
    this.lifecycle.cancel();
    this.publish({
      status: "unauthenticated",
      reason: "sign_in_required",
    });

    if (stored && identity && pending) {
      const delivery = await this.sendSelfRevocation(pending);
      this.runtime.store.clearProductSession(
        delivery === "delivered" ? null : pending,
      );
      return;
    }

    this.runtime.store.clearProductSession(pending);
    await this.deliverPendingRevocation();
  }

  subscribe(listener: (state: AgenteraAuthPublicState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.sessionRevision += 1;
    const attempt = this.activeAttempt;
    if (attempt) {
      attempt.cancelled = true;
      attempt.listener?.cancel();
      attempt.listener?.close();
    }
    this.activeAttempt = null;
    this.clearInMemoryAuthorization();
    this.lifecycle.dispose();
    this.listeners.clear();
  }

  private acceptOnlineTokens(
    tokens: AgenteraTokenSet,
    client: AgenteraCloudClientPort,
  ): void {
    const identity = this.runtime.store.getInstallation();
    if (!identity) {
      throw new Error("AgentEra installation identity is unavailable.");
    }
    const trustedServerTime = new Date(tokens.trustedServerTime);
    if (
      !Number.isFinite(trustedServerTime.getTime()) ||
      trustedServerTime.toISOString() !== tokens.trustedServerTime
    ) {
      throw new Error("AgentEra trusted server time is invalid.");
    }
    const entitlement = verifyAgenteraOfflineEntitlement({
      serialized: tokens.offlineEntitlement,
      issuer: client.origin,
      audience: AGENTERA_OFFLINE_AUDIENCE,
      publicKeys: this.publicKeysFor(client.origin),
      expectedBinding: {
        userId: tokens.userId,
        deviceId: tokens.deviceId,
        installationId: identity.installationId,
        personalSpaceId: tokens.personalSpaceId,
      },
      expectedExpiresAt: tokens.offlineExpiresAt,
      now: trustedServerTime,
    });
    this.runtime.store.replaceProductSession(
      {
        userId: tokens.userId,
        personalSpaceId: tokens.personalSpaceId,
        deviceId: tokens.deviceId,
        refreshToken: tokens.refreshToken,
        offlineEntitlement: tokens.offlineEntitlement,
        offlineExpiresAt: entitlement.expiresAt,
        lastTrustedServerTime: tokens.trustedServerTime,
      },
      null,
    );
    this.accessToken = tokens.accessToken;
    this.entitlement = entitlement;
    this.timeAnchor = new AgenteraTrustedTimeAnchor({
      trustedServerTime: tokens.trustedServerTime,
      wallNow: this.wallNow,
      monotonicNow: this.monotonicNow,
      detectInitialRollback: false,
    });
  }

  private enterOfflineMode(
    stored: ProductSession,
    client: AgenteraCloudClientPort,
  ): AgenteraAuthPublicState {
    try {
      const identity = this.runtime.store.getInstallation();
      if (!identity) throw new Error("installation identity unavailable");
      const anchor =
        this.timeAnchor ??
        new AgenteraTrustedTimeAnchor({
          trustedServerTime: stored.lastTrustedServerTime,
          wallNow: this.wallNow,
          monotonicNow: this.monotonicNow,
        });
      const evaluated = anchor.evaluate();
      if (evaluated.rollbackDetected) {
        this.entitlement = null;
        this.timeAnchor = null;
        return { status: "blocked", reason: "clock_rollback" };
      }
      const entitlement = verifyAgenteraOfflineEntitlement({
        serialized: stored.offlineEntitlement,
        issuer: client.origin,
        audience: AGENTERA_OFFLINE_AUDIENCE,
        publicKeys: this.publicKeysFor(client.origin),
        expectedBinding: {
          userId: stored.userId,
          deviceId: stored.deviceId,
          installationId: identity.installationId,
          personalSpaceId: stored.personalSpaceId,
        },
        expectedExpiresAt: stored.offlineExpiresAt,
        now: evaluated.trustedNow,
      });
      this.entitlement = entitlement;
      this.timeAnchor = anchor;
      return {
        status: "offline",
        userId: stored.userId,
        personalSpaceId: stored.personalSpaceId,
        deviceId: stored.deviceId,
        offlineExpiresAt: entitlement.expiresAt,
        cloudAvailable: false,
      };
    } catch (error) {
      this.entitlement = null;
      this.timeAnchor = null;
      if (
        error instanceof AgenteraOfflineEntitlementError &&
        error.code === "expired"
      ) {
        return { status: "blocked", reason: "offline_expired" };
      }
      if (/secure storage/i.test(String(error))) {
        return { status: "blocked", reason: "secure_storage_unavailable" };
      }
      return { status: "blocked", reason: "sign_in_required" };
    }
  }

  private publicKeysFor(origin: string): Readonly<Record<string, string>> {
    return (
      this.runtime.offlinePublicKeys ??
      getBundledAgenteraOfflinePublicKeys(origin)
    );
  }

  private async deliverPendingRevocation(): Promise<PendingDelivery> {
    const pending = this.runtime.store.getPendingRevocation();
    if (!pending) return "none";
    const identity = this.runtime.store.getInstallation();
    if (!identity) return "pending";
    const refreshed = refreshPendingAgenteraSelfRevocation(
      pending,
      identity,
      new Date(this.wallNow()),
    );
    this.runtime.store.replaceProductSession(null, refreshed);
    const delivery = await this.sendSelfRevocation(refreshed);
    if (delivery === "delivered") {
      this.runtime.store.clearPendingRevocation();
    }
    return delivery;
  }

  private async sendSelfRevocation(
    record: PendingSelfRevocation,
  ): Promise<PendingDelivery> {
    try {
      await this.runtime.getCloudClient().deliverSelfRevocation(record);
      return "delivered";
    } catch (error) {
      if (
        error instanceof AgenteraCloudClientError &&
        (error.status === 404 ||
          error.status === 409 ||
          error.code === "device_not_found" ||
          error.code === "self_revoke_replayed")
      ) {
        return "delivered";
      }
      if (isControlPlaneUnavailable(error)) {
        this.lifecycle.noteControlPlaneUnavailable();
      }
      return "pending";
    }
  }

  private authenticatedState(
    tokens: AgenteraTokenSet,
  ): AgenteraAuthPublicState {
    return {
      status: "authenticated",
      userId: tokens.userId,
      personalSpaceId: tokens.personalSpaceId,
      deviceId: tokens.deviceId,
      offlineExpiresAt: tokens.offlineExpiresAt,
      cloudAvailable: true,
    };
  }

  private clearInMemoryAuthorization(): void {
    this.accessToken = null;
    this.entitlement = null;
    this.timeAnchor = null;
  }

  private publish(state: AgenteraAuthPublicState): AgenteraAuthPublicState {
    const previous = this.state;
    if (hasProductAccess(previous) && !hasProductAccess(state)) {
      try {
        this.runtime.onProductAccessLost?.();
      } catch (error) {
        console.error(
          "[AgentEra] Failed to stop the active Runtime context",
          error,
        );
      }
    }
    this.state = serializeAgenteraAuthPublicState(state);
    const publicState = this.getPublicState();
    for (const listener of this.listeners) listener(publicState);
    return publicState;
  }

  private publishSecureFailure(error: unknown): AgenteraAuthPublicState {
    this.clearInMemoryAuthorization();
    this.lifecycle.cancel();
    if (/secure storage/i.test(String(error))) {
      return this.publish({
        status: "blocked",
        reason: "secure_storage_unavailable",
      });
    }
    return this.publish({ status: "blocked", reason: "sign_in_required" });
  }
}

export function createAgenteraAuthController(
  runtime: AgenteraAuthControllerRuntime,
): AgenteraAuthControllerImpl {
  return new AgenteraAuthControllerImpl(runtime);
}
