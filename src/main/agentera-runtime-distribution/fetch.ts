export interface RuntimeFetchInit {
  method: "GET";
  redirect: "follow" | "error";
  signal: AbortSignal;
  headers: Record<string, string>;
}

export type RuntimeFetch = (
  url: string,
  init: RuntimeFetchInit,
) => Promise<Response>;

export const nodeRuntimeFetch: RuntimeFetch = (url, init) => fetch(url, init);
