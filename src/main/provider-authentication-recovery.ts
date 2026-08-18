import type { AgenteraOwnerEpochLease } from "./agentera-connection-owner";
import type {
  ProviderCredentialRefreshInput,
  ProviderCredentialRefreshPort,
} from "./provider-credential-refresh";

export type ProviderAuthenticationCredentialSource =
  | "runtime_refreshable"
  | "static_key"
  | "none";

export type ProviderAuthenticationRecoveryErrorCode =
  | "cancelled"
  | "owner_changed";

export class ProviderAuthenticationRecoveryError extends Error {
  readonly code: ProviderAuthenticationRecoveryErrorCode;

  constructor(code: ProviderAuthenticationRecoveryErrorCode) {
    super(`Provider authentication recovery stopped: ${code}.`);
    this.name = "ProviderAuthenticationRecoveryError";
    this.code = code;
  }
}

export interface ProviderAuthenticationRecoveryOutcome<T> {
  result: T;
  refreshAttempted: boolean;
  retried: boolean;
  finalAuthenticationRejected: boolean;
}

export interface ProviderAuthenticationRecoveryInput<T> {
  ownerLease: AgenteraOwnerEpochLease;
  /** Optional caller cancellation in addition to owner-epoch cancellation. */
  signal?: AbortSignal;
  credentialSource: ProviderAuthenticationCredentialSource;
  refreshPort: ProviderCredentialRefreshPort;
  refreshInput: Omit<ProviderCredentialRefreshInput, "ownerLease">;
  /** Return false when Runtime reported success but no rotated credential
   *  could be read locally. In that case the failed credential is never
   *  reused for the retry. */
  canRetry?: () => boolean | Promise<boolean>;
  fetchOnce: () => Promise<T>;
  isAuthenticationRejected: (result: T) => boolean;
}

function assertOwner(
  lease: AgenteraOwnerEpochLease,
  signal?: AbortSignal,
): void {
  try {
    lease.assertCurrent();
  } catch {
    throw new ProviderAuthenticationRecoveryError("owner_changed");
  }
  if (lease.signal.aborted || signal?.aborted) {
    throw new ProviderAuthenticationRecoveryError("cancelled");
  }
}

function waitForCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new ProviderAuthenticationRecoveryError("cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new ProviderAuthenticationRecoveryError("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Execute one idempotent provider request with a strictly bounded 401
 * recovery policy. Static-key and unauthenticated requests return their first
 * result untouched; only a Runtime-owned refreshable credential can trigger
 * one refresh and one retry.
 */
export async function runProviderAuthenticationRecovery<T>(
  input: ProviderAuthenticationRecoveryInput<T>,
): Promise<ProviderAuthenticationRecoveryOutcome<T>> {
  assertOwner(input.ownerLease, input.signal);
  const first = await input.fetchOnce();
  assertOwner(input.ownerLease, input.signal);
  if (
    !input.isAuthenticationRejected(first) ||
    input.credentialSource !== "runtime_refreshable"
  ) {
    return {
      result: first,
      refreshAttempted: false,
      retried: false,
      finalAuthenticationRejected: input.isAuthenticationRejected(first),
    };
  }

  const refreshAttempted = true;
  let refreshed: Awaited<ReturnType<ProviderCredentialRefreshPort["refresh"]>>;
  try {
    refreshed = await waitForCancellation(
      input.refreshPort.refresh({
        ...input.refreshInput,
        ownerLease: input.ownerLease,
      }),
      input.signal,
    );
  } catch {
    assertOwner(input.ownerLease, input.signal);
    return {
      result: first,
      refreshAttempted,
      retried: false,
      finalAuthenticationRejected: true,
    };
  }
  assertOwner(input.ownerLease, input.signal);
  if (refreshed.status !== "refreshed") {
    return {
      result: first,
      refreshAttempted,
      retried: false,
      finalAuthenticationRejected: true,
    };
  }

  if (input.canRetry && !(await input.canRetry())) {
    return {
      result: first,
      refreshAttempted,
      retried: false,
      finalAuthenticationRejected: true,
    };
  }
  assertOwner(input.ownerLease, input.signal);

  const second = await input.fetchOnce();
  assertOwner(input.ownerLease, input.signal);
  return {
    result: second,
    refreshAttempted,
    retried: true,
    finalAuthenticationRejected: input.isAuthenticationRejected(second),
  };
}
