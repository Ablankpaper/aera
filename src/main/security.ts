import type { WebContents, WebPreferences } from "electron";
import { pathToFileURL } from "url";

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);
const LOCAL_WEBVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type WebviewPreferences = WebPreferences & {
  preloadURL?: string;
};

function parseUrl(rawUrl: unknown): URL | null {
  if (typeof rawUrl !== "string") return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
  const url = parseUrl(rawUrl);
  return !!url && EXTERNAL_PROTOCOLS.has(url.protocol);
}

const AGENTERA_AUTH_REQUIRED_QUERY = new Set([
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "installation_id",
  "device_public_key",
  "device_name",
  "platform",
  "app_version",
]);

export function isAllowedAgenteraAuthExternalUrl(
  rawUrl: unknown,
  configuredOrigin: string,
): rawUrl is string {
  const url = parseUrl(rawUrl);
  const origin = parseUrl(configuredOrigin);
  if (
    !url ||
    !origin ||
    url.origin !== origin.origin ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    url.pathname !== "/oauth/authorize" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  const keys = [...url.searchParams.keys()];
  const allowedKeys = new Set([...AGENTERA_AUTH_REQUIRED_QUERY, "prompt"]);
  if (
    keys.some(
      (key) =>
        !allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1,
    ) ||
    [...AGENTERA_AUTH_REQUIRED_QUERY].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    )
  ) {
    return false;
  }
  if (
    url.searchParams.get("client_id") !== "agentera-studio" ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(
      url.searchParams.get("device_public_key") ?? "",
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      url.searchParams.get("installation_id") ?? "",
    )
  ) {
    return false;
  }
  const prompt = url.searchParams.get("prompt");
  if (prompt !== null && prompt !== "select_account") return false;
  const deviceName = url.searchParams.get("device_name") ?? "";
  const appVersion = url.searchParams.get("app_version") ?? "";
  const platform = url.searchParams.get("platform") ?? "";
  if (
    deviceName.length < 1 ||
    deviceName.length > 100 ||
    appVersion.length < 1 ||
    appVersion.length > 64 ||
    !new Set(["darwin", "windows", "linux"]).has(platform)
  ) {
    return false;
  }
  const redirect = parseUrl(url.searchParams.get("redirect_uri"));
  if (
    !redirect ||
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port === "" ||
    Number(redirect.port) < 1 ||
    Number(redirect.port) > 65535 ||
    redirect.pathname !== "/agentera/oauth/callback" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirect.username !== "" ||
    redirect.password !== ""
  ) {
    return false;
  }
  return true;
}

export function isAllowedAppNavigationUrl(
  rawUrl: unknown,
  rendererHtmlPath: string,
  devServerUrl?: string,
): rawUrl is string {
  const url = parseUrl(rawUrl);
  if (!url) return false;

  const devServer = parseUrl(devServerUrl);
  if (devServer) {
    return url.origin === devServer.origin;
  }

  const rendererUrl = pathToFileURL(rendererHtmlPath);
  return (
    url.protocol === "file:" && url.href.split("#")[0] === rendererUrl.href
  );
}

export function isAllowedWebviewUrl(
  rawUrl: unknown,
  allowHttps = false,
): rawUrl is string {
  if (
    typeof rawUrl === "string" &&
    (rawUrl === "about:blank" || rawUrl.startsWith("about:blank"))
  ) {
    return true;
  }

  const url = parseUrl(rawUrl);
  if (!url) {
    console.warn(`[SECURITY] Blocked webview URL (could not parse): ${rawUrl}`);
    return false;
  }

  if (url.protocol === "http:") {
    if (LOCAL_WEBVIEW_HOSTS.has(url.hostname)) {
      const port = Number(url.port);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
        return true;
      }
    }
    console.warn(`[SECURITY] Blocked local/remote HTTP webview URL: ${rawUrl}`);
    return false;
  }

  if (url.protocol === "https:") {
    if (allowHttps) {
      return true;
    }
    console.warn(
      `[SECURITY] Blocked HTTPS webview URL (not allowed for this webview): ${rawUrl}`,
    );
    return false;
  }

  console.warn(
    `[SECURITY] Blocked webview URL (unsupported protocol): ${rawUrl}`,
  );
  return false;
}

export function hardenWebviewPreferences(
  webPreferences: WebviewPreferences,
): void {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
}

export function hardenAttachedWebContents(
  webContents: WebContents,
  isWebPreview = false,
): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (!isAllowedWebviewUrl(url, isWebPreview)) {
      event.preventDefault();
    }
  });
  webContents.on("will-redirect", (event, url) => {
    if (!isAllowedWebviewUrl(url, isWebPreview)) {
      event.preventDefault();
    }
  });
}
