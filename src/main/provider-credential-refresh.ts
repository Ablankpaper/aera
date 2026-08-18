import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgenteraOwnerEpochLease } from "./agentera-connection-owner";
import {
  getRuntimeInvocation,
  type RuntimeInvocation,
} from "./agentera-runtime-distribution/invocation";
import { profileHome } from "./utils";

export type ProviderCredentialRefreshResult =
  | { status: "refreshed" }
  | { status: "not_refreshable" }
  | { status: "rejected" }
  | { status: "unavailable" };

export interface RuntimeCredentialEligibility {
  /** Only this source is allowed to cross into the Runtime refresh port. */
  source: "runtime_pool" | "static_key" | "renderer" | "unknown";
  authType: string;
  hasRefreshToken: boolean;
}

export interface ProviderCredentialRefreshInput {
  provider: string;
  profile?: string;
  ownerLease: AgenteraOwnerEpochLease;
  eligibility: RuntimeCredentialEligibility;
}

export interface ProviderCredentialRefreshPort {
  refresh(
    input: ProviderCredentialRefreshInput,
  ): Promise<ProviderCredentialRefreshResult>;
}

interface RefreshProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "error" | "close", listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: boolean;
  },
) => RefreshProcess;

export interface ProviderCredentialRefreshPortOptions {
  getInvocation?: () => RuntimeInvocation | null;
  spawn?: SpawnProcess;
  timeoutMs?: number;
}

/**
 * Fixed, non-secret Runtime bridge. OAuth protocol details, refresh-token
 * locking, rotation, and auth.json persistence stay inside Runtime's
 * credential_pool implementation. Desktop receives one status word only.
 */
export const RUNTIME_CREDENTIAL_REFRESH_SCRIPT = [
  "import sys",
  "from agent.credential_pool import load_pool",
  "provider = sys.argv[1]",
  "pool = load_pool(provider)",
  // A freshly loaded pool has no current_id yet. `peek()` selects the same
  // safe candidate Runtime would use for its next request instead of making
  // every first refresh look non-refreshable.
  "entry = pool.current() or pool.peek()",
  "if entry is None or entry.auth_type != 'oauth' or not entry.refresh_token:",
  "    print('NOT_REFRESHABLE')",
  "else:",
  // `try_refresh_matching` is present in current Runtime versions and
  // refreshes the selected entry; the fallback keeps compatibility with an
  // older Runtime that only exposes `try_refresh_current`.
  "    if hasattr(pool, 'try_refresh_matching'):",
  "        refreshed = pool.try_refresh_matching()",
  "    else:",
  "        acquire = getattr(pool, 'acquire_lease', None)",
  "        if callable(acquire): acquire(entry.id)",
  "        refreshed = pool.try_refresh_current()",
  "    print('REFRESHED' if refreshed is not None else 'REJECTED')",
].join("\n");

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 4 * 1024;

function isEligible(input: ProviderCredentialRefreshInput): boolean {
  return (
    input.eligibility.source === "runtime_pool" &&
    input.eligibility.authType.trim().toLocaleLowerCase() === "oauth" &&
    input.eligibility.hasRefreshToken
  );
}

function boundedProvider(value: string): string | null {
  const provider = value.trim();
  if (
    !provider ||
    provider.length > 128 ||
    /[\0\r\n]/.test(provider) ||
    !/^[A-Za-z0-9_.:-]+$/.test(provider)
  ) {
    return null;
  }
  return provider;
}

function consumeStatus(output: string): ProviderCredentialRefreshResult {
  const status = output.trim();
  if (status === "REFRESHED") return { status: "refreshed" };
  if (status === "REJECTED") return { status: "rejected" };
  if (status === "NOT_REFRESHABLE") return { status: "not_refreshable" };
  return { status: "unavailable" };
}

function appendBounded(current: string, chunk: unknown): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
  const text = String(chunk);
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  // `remaining` is a byte budget, not a JavaScript character count. Slice the
  // encoded bytes so multi-byte Runtime output cannot exceed the cap.
  return (
    current + Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8")
  );
}

export function createProviderCredentialRefreshPort(
  options: ProviderCredentialRefreshPortOptions = {},
): ProviderCredentialRefreshPort {
  const getInvocation = options.getInvocation ?? getRuntimeInvocation;
  const spawnProcess =
    options.spawn ??
    ((command, args, spawnOptions) =>
      nodeSpawn(command, [...args], {
        ...spawnOptions,
        stdio: spawnOptions.stdio,
      }) as unknown as ChildProcessWithoutNullStreams);
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  return {
    async refresh(input): Promise<ProviderCredentialRefreshResult> {
      if (!isEligible(input)) return { status: "not_refreshable" };
      const provider = boundedProvider(input.provider);
      if (!provider || input.ownerLease.signal.aborted) {
        return { status: "not_refreshable" };
      }
      try {
        input.ownerLease.assertCurrent();
      } catch {
        return { status: "not_refreshable" };
      }
      const invocation = getInvocation();
      if (invocation === null) return { status: "unavailable" };

      return await new Promise<ProviderCredentialRefreshResult>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        let child: RefreshProcess | null = null;
        const finish = (result: ProviderCredentialRefreshResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          input.ownerLease.signal.removeEventListener("abort", abort);
          resolve(result);
        };
        const abort = (): void => {
          child?.kill("SIGTERM");
          finish({ status: "unavailable" });
        };
        try {
          child = spawnProcess(
            invocation.python,
            ["-c", RUNTIME_CREDENTIAL_REFRESH_SCRIPT, provider],
            {
              cwd: invocation.workingDirectory,
              // Runtime must refresh the credential pool for the requested
              // Desktop Profile, not whichever profile happened to be active
              // when the long-lived invocation was selected.
              env: invocation.environment({
                ...process.env,
                HERMES_HOME: profileHome(input.profile),
              }),
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          );
          child.stdout.on("data", (chunk) => {
            output = appendBounded(output, chunk);
          });
          // Read and discard stderr so a full pipe cannot deadlock the child;
          // raw Runtime exceptions never enter logs or the returned result.
          child.stderr.on("data", () => undefined);
          child.once("error", () => finish({ status: "unavailable" }));
          child.once("close", (code) => {
            if (code !== 0) {
              finish({ status: "unavailable" });
              return;
            }
            try {
              input.ownerLease.assertCurrent();
            } catch {
              finish({ status: "unavailable" });
              return;
            }
            finish(consumeStatus(output));
          });
          timer = setTimeout(() => {
            child?.kill("SIGTERM");
            finish({ status: "unavailable" });
          }, timeoutMs);
          input.ownerLease.signal.addEventListener("abort", abort, {
            once: true,
          });
          if (input.ownerLease.signal.aborted) abort();
        } catch {
          finish({ status: "unavailable" });
        }
      });
    },
  };
}
