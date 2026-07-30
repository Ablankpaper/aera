import type { ClientRequest, ClientRequestConstructorOptions } from "electron";

import {
  RuntimeDownloadError,
  RuntimeDownloadTimeoutError,
  resolveRuntimeDownloadRedirect,
  type RuntimeDownloadUrlResolver,
} from "./downloader";

export type ElectronRuntimeRequestFactory = (
  options: ClientRequestConstructorOptions,
) => ClientRequest;

export function createElectronRuntimeDownloadUrlResolver(
  requestFactory: ElectronRuntimeRequestFactory,
): RuntimeDownloadUrlResolver {
  return (initialUrl, headers, signal, timeouts, maxRedirects) =>
    new Promise<URL>((resolve, reject) => {
      let currentUrl = new URL(initialUrl);
      let redirects = 0;
      let settled = false;
      const request = requestFactory({
        method: "GET",
        url: initialUrl.href,
        headers,
        redirect: "manual",
        credentials: "omit",
        bypassCustomProtocolHandlers: true,
      });
      const onAbort = (): void => {
        finish(() =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new RuntimeDownloadError(
                  "Runtime download URL resolution was cancelled",
                ),
          ),
        );
        request.abort();
      };
      const connectTimer = setTimeout(() => {
        finish(() =>
          reject(
            new RuntimeDownloadTimeoutError(
              "Runtime download connection timeout",
            ),
          ),
        );
        request.abort();
      }, timeouts.connectMs);
      connectTimer.unref?.();
      const cleanup = (): void => {
        clearTimeout(connectTimer);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      request.on("redirect", (_statusCode, _method, redirectUrl) => {
        try {
          const next = resolveRuntimeDownloadRedirect(
            currentUrl,
            redirectUrl,
            redirects,
            maxRedirects,
          );
          redirects += 1;
          currentUrl = next;
          request.followRedirect();
        } catch (error) {
          finish(() => reject(error));
          request.abort();
        }
      });
      request.once("response", () => {
        finish(() => resolve(currentUrl));
        request.abort();
      });
      request.once("error", (error) => {
        finish(() => reject(error));
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      request.end();
    });
}
