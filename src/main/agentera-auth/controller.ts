import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import { serializeAgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraCloudClientPort,
  AgenteraDeviceMetadata,
  AgenteraTokenSet,
} from "./client";
import { AgenteraCloudClientError } from "./client";
import { getOrCreateAgenteraDeviceIdentity } from "./device-key";
import type {
  AgenteraLoopbackListener,
  AgenteraLoopbackOptions,
} from "./loopback";
import { startAgenteraLoopbackListener } from "./loopback";
import type { AgenteraPkceAttempt } from "./pkce";
import { createAgenteraPkceAttempt } from "./pkce";
import type { AgenteraAuthStore } from "./store";

export interface AgenteraAuthController {
  initialize(): Promise<AgenteraAuthPublicState>;
  getPublicState(): AgenteraAuthPublicState;
  startBrowserLogin(options?: {
    forceAccountSelection?: boolean;
  }): Promise<void>;
  cancelBrowserLogin(): Promise<void>;
  refreshOnline(): Promise<AgenteraAuthPublicState>;
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
}

interface ActiveAttempt {
  cancelled: boolean;
  listener: AgenteraLoopbackListener | null;
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
  private activeAttempt: ActiveAttempt | null = null;
  private accessToken: string | null = null;

  constructor(runtime: AgenteraAuthControllerRuntime) {
    this.runtime = {
      ...runtime,
      createPkce: runtime.createPkce ?? createAgenteraPkceAttempt,
      startLoopback: runtime.startLoopback ?? startAgenteraLoopbackListener,
    };
  }

  async initialize(): Promise<AgenteraAuthPublicState> {
    try {
      if (!this.runtime.store.getProductSession()) {
        return this.publish({
          status: "unauthenticated",
          reason: "sign_in_required",
        });
      }
      return this.refreshOnline();
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
    const attempt: ActiveAttempt = { cancelled: false, listener: null };
    this.activeAttempt = attempt;
    this.publish({ status: "checking" });

    try {
      const identity = getOrCreateAgenteraDeviceIdentity(this.runtime.store);
      const pkce = this.runtime.createPkce();
      const listener = await this.runtime.startLoopback({
        expectedState: pkce.state,
      });
      attempt.listener = listener;
      if (attempt.cancelled) {
        // Cancellation can win while the listener is still binding. Consume
        // its cancellation rejection and stop before constructing or opening
        // any browser URL.
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
      this.persistTokens(tokens);
      this.publish(this.authenticatedState(tokens));
    } catch (error) {
      this.accessToken = null;
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
    let stored;
    try {
      stored = this.runtime.store.getProductSession();
    } catch (error) {
      return this.publishSecureFailure(error);
    }
    if (!stored) {
      this.accessToken = null;
      return this.publish({
        status: "unauthenticated",
        reason: "sign_in_required",
      });
    }
    try {
      const tokens = await this.runtime
        .getCloudClient()
        .refreshSession(stored.refreshToken);
      if (
        tokens.userId !== stored.userId ||
        tokens.personalSpaceId !== stored.personalSpaceId ||
        tokens.deviceId !== stored.deviceId
      ) {
        throw new AgenteraCloudClientError(0, "session_binding_changed");
      }
      this.persistTokens(tokens);
      return this.publish(this.authenticatedState(tokens));
    } catch (error) {
      this.accessToken = null;
      if (error instanceof AgenteraCloudClientError && error.status === 401) {
        this.runtime.store.clearProductSession();
        return this.publish({
          status: "unauthenticated",
          reason: "sign_in_required",
        });
      }
      // Task 13 replaces this fail-closed state with locally verified offline
      // authorization. An unverified stored blob never grants access here.
      return this.publish({ status: "blocked", reason: "sign_in_required" });
    }
  }

  async logout(): Promise<void> {
    const stored = this.runtime.store.getProductSession();
    if (stored) {
      await this.runtime.getCloudClient().revokeSession(stored.refreshToken);
    }
    this.accessToken = null;
    this.runtime.store.clearProductSession();
    this.publish({
      status: "unauthenticated",
      reason: "sign_in_required",
    });
  }

  subscribe(listener: (state: AgenteraAuthPublicState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    const attempt = this.activeAttempt;
    if (attempt) {
      attempt.cancelled = true;
      attempt.listener?.cancel();
      attempt.listener?.close();
    }
    this.activeAttempt = null;
    this.accessToken = null;
    this.listeners.clear();
  }

  private persistTokens(tokens: AgenteraTokenSet): void {
    this.runtime.store.replaceProductSession(
      {
        userId: tokens.userId,
        personalSpaceId: tokens.personalSpaceId,
        deviceId: tokens.deviceId,
        refreshToken: tokens.refreshToken,
        offlineEntitlement: tokens.offlineEntitlement,
        offlineExpiresAt: tokens.offlineExpiresAt,
        lastTrustedServerTime: tokens.trustedServerTime,
      },
      null,
    );
    this.accessToken = tokens.accessToken;
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

  private publish(state: AgenteraAuthPublicState): AgenteraAuthPublicState {
    this.state = serializeAgenteraAuthPublicState(state);
    const publicState = this.getPublicState();
    for (const listener of this.listeners) listener(publicState);
    return publicState;
  }

  private publishSecureFailure(error: unknown): AgenteraAuthPublicState {
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
