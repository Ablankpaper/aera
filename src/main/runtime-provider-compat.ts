/**
 * Small compatibility boundary between Aera's historical public provider
 * labels and Hermes Agent's runtime provider registry.
 *
 * Aera historically persisted `openai` for every OpenAI-compatible endpoint.
 * Hermes Agent reserves `openai-api` for the official API and `custom` for
 * loopback/compatible endpoints; a bare `openai` therefore fails before a
 * request reaches the configured model server.
 */

function hostname(value: string): string {
  try {
    return new URL(value).hostname.toLocaleLowerCase();
  } catch {
    return "";
  }
}

function isOfficialOpenAiHost(host: string): boolean {
  return (
    host === "api.openai.com" ||
    host.endsWith(".api.openai.com") ||
    host === "openai.azure.com" ||
    host.endsWith(".openai.azure.com")
  );
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local")
  );
}

/** Resolve one public route to the provider id Hermes can actually start. */
// @lat: [[model-selection#Session model override#Request-scoped Agent authentication boundary]]
export function runtimeProviderForRoute(
  provider: string,
  baseUrl: string,
): string {
  const normalizedProvider = provider.trim().toLocaleLowerCase();
  if (normalizedProvider !== "openai") return provider.trim();

  const host = hostname(baseUrl);
  if (!baseUrl.trim() || isOfficialOpenAiHost(host)) return "openai-api";
  if (isLoopbackHost(host)) return "custom";

  // Third-party OpenAI-compatible routes retain the logical identity here.
  // The request-scoped Runtime resolver matches the explicit endpoint to its
  // named Profile provider, avoiding a global credential fallback.
  return provider.trim();
}

/** Compare a public catalog identity with the provider persisted for Hermes. */
export function runtimeProviderMatchesPublicRoute(
  publicProvider: string,
  baseUrl: string,
  runtimeProvider: string,
): boolean {
  return (
    runtimeProviderForRoute(publicProvider, baseUrl).toLocaleLowerCase() ===
    runtimeProvider.trim().toLocaleLowerCase()
  );
}

function directModelBlock(content: string): {
  start: number;
  end: number;
  provider: { start: number; end: number; value: string } | null;
  baseUrl: string;
} | null {
  const header = /^model:[^\S\r\n]*(?:\r?\n|$)/m.exec(content);
  if (!header || header.index === undefined) return null;
  const start = header.index + header[0].length;
  const rest = content.slice(start);
  const nextTopLevel = /^(?![ \t])[A-Za-z0-9_"'-]+:/m.exec(rest);
  const end = nextTopLevel?.index === undefined
    ? content.length
    : start + nextTopLevel.index;
  const block = content.slice(start, end);
  const child = (key: string): { start: number; end: number; value: string } | null => {
    const expression = new RegExp(
      `^([ \\t]+)${key}:[ \\t]*([^\\r\\n#]*?)[ \\t]*(?:#.*)?$`,
      "m",
    );
    const match = expression.exec(block);
    if (!match || match.index === undefined) return null;
    const raw = match[2].trim();
    const value = raw.replace(/^("|')(.*)\1$/s, "$2");
    const valueStart = start + match.index + match[0].indexOf(match[2]);
    return { start: valueStart, end: valueStart + match[2].length, value };
  };
  return {
    start,
    end,
    provider: child("provider"),
    baseUrl: child("base_url")?.value ?? "",
  };
}

/** Migrate only the legacy top-level model provider; all other YAML is kept. */
export function migrateLegacyOpenAiModelRoute(content: string): string {
  const block = directModelBlock(content);
  if (!block || !block.provider) return content;
  if (block.provider.value.trim().toLocaleLowerCase() !== "openai") {
    return content;
  }
  const runtimeProvider = runtimeProviderForRoute("openai", block.baseUrl);
  if (runtimeProvider === "openai") return content;
  const replacement = JSON.stringify(runtimeProvider);
  return `${content.slice(0, block.provider.start)}${replacement}${content.slice(
    block.provider.end,
  )}`;
}
