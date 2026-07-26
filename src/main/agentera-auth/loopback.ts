import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

const CALLBACK_PATH = "/agentera/oauth/callback";
const MAX_REQUEST_TARGET_LENGTH = 4096;
// Cloud keeps an OAuth request alive for ten minutes. Give the user enough
// time to switch browser profiles and complete sign-in while still bounding a
// forgotten local listener.
const DEFAULT_TIMEOUT_MS = 300_000;

export interface AgenteraLoopbackCallback {
  authorizationCode: string;
}

export interface AgenteraLoopbackListener {
  redirectUri: string;
  callback: Promise<AgenteraLoopbackCallback>;
  cancel(): void;
  close(): void;
}

export type AgenteraLoopbackServerFactory = (
  handler: RequestListener,
) => Server;

export interface AgenteraLoopbackOptions {
  expectedState: string;
  timeoutMs?: number;
  host?: string;
  serverFactory?: AgenteraLoopbackServerFactory;
}

function decodeCanonical32(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    return null;
  }
  return decoded;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", contentType);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

const SUCCESS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>AgentEra Studio</title><style>body{font-family:system-ui,sans-serif;margin:4rem;color:#111}main{max-width:34rem;margin:auto}</style></head>
<body><main><h1>登录已完成</h1><p>正在返回 AgentEra Studio，现在可以关闭此页面。</p></main></body></html>`;

export async function startAgenteraLoopbackListener(
  options: AgenteraLoopbackOptions,
): Promise<AgenteraLoopbackListener> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("AgentEra OAuth listener must bind to 127.0.0.1 loopback.");
  }
  const expectedStateBytes = decodeCanonical32(options.expectedState);
  if (!expectedStateBytes) {
    throw new Error("AgentEra OAuth listener requires a 256-bit state.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("AgentEra OAuth listener timeout is invalid.");
  }

  let resolveCallback!: (value: AgenteraLoopbackCallback) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<AgenteraLoopbackCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A bind error can happen before the listener object reaches its caller.
  // Keep that rejected internal promise from becoming an unhandled rejection.
  void callback.catch(() => undefined);

  let settled = false;
  let consumed = false;
  let timer: NodeJS.Timeout | null = null;

  const closeTransport = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      server.close();
    } catch {
      // A server that failed before listen may already be closed.
    }
  };
  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error(message));
    closeTransport();
  };

  const handler: RequestListener = (request, response) => {
    const target = request.url ?? "";
    if (target.length > MAX_REQUEST_TARGET_LENGTH) {
      send(response, 414, "Request target is too large.");
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      send(response, 405, "Method not allowed.");
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(target, "http://127.0.0.1");
    } catch {
      send(response, 400, "Invalid callback.");
      return;
    }
    if (requestUrl.pathname !== CALLBACK_PATH) {
      send(response, 404, "Not found.");
      return;
    }
    if (consumed) {
      send(response, 409, "Callback already consumed.");
      return;
    }
    const keys = [...requestUrl.searchParams.keys()];
    if (
      keys.some((key) => key !== "code" && key !== "state") ||
      requestUrl.searchParams.getAll("code").length !== 1 ||
      requestUrl.searchParams.getAll("state").length !== 1
    ) {
      send(response, 400, "Invalid callback.");
      return;
    }
    const code = requestUrl.searchParams.get("code") ?? "";
    const state = requestUrl.searchParams.get("state") ?? "";
    const codeBytes = decodeCanonical32(code);
    const stateBytes = decodeCanonical32(state);
    if (
      !codeBytes ||
      !stateBytes ||
      !timingSafeEqual(stateBytes, expectedStateBytes)
    ) {
      send(response, 400, "Invalid callback.");
      return;
    }

    consumed = true;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    resolveCallback({ authorizationCode: code });
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    send(response, 200, SUCCESS_PAGE, "text/html; charset=utf-8");
    setImmediate(closeTransport);
  };

  const server: Server = (options.serverFactory ?? createServer)(handler);
  let redirectUri = "";
  await new Promise<void>((resolveStart, rejectStart) => {
    let started = false;
    server.once("error", (error) => {
      const message = "AgentEra OAuth loopback listener failed.";
      if (!started) {
        settled = true;
        rejectCallback(new Error(message));
        rejectStart(new Error(`${message} ${(error as Error).message}`));
        return;
      }
      fail(message);
    });
    server.listen(0, host, () => {
      const address = server.address();
      if (
        !address ||
        typeof address === "string" ||
        address.address !== host ||
        address.port < 1 ||
        address.port > 65535
      ) {
        const error = new Error(
          "AgentEra OAuth listener did not bind to IPv4 loopback.",
        );
        settled = true;
        rejectCallback(error);
        rejectStart(error);
        closeTransport();
        return;
      }
      started = true;
      redirectUri = `http://${host}:${address.port}${CALLBACK_PATH}`;
      resolveStart();
    });
  });

  timer = setTimeout(
    () => fail("AgentEra browser sign-in timed out."),
    timeoutMs,
  );
  timer.unref?.();

  return {
    redirectUri,
    callback,
    cancel: () => fail("AgentEra browser sign-in was cancelled."),
    close: () => {
      if (!settled) {
        settled = true;
        rejectCallback(new Error("AgentEra browser sign-in was closed."));
      }
      closeTransport();
    },
  };
}
