const INTERNAL_BETA_VERSION_PATTERN = /^\d+\.\d+\.\d+-internal-beta\.[1-9]\d*$/;

export function isInternalBetaDesktopVersion(version: string): boolean {
  return INTERNAL_BETA_VERSION_PATTERN.test(version.trim());
}

export const INTERNAL_BETA_UPDATE_KEY_ID = "desktop-update-2026-07";
export const INTERNAL_BETA_UPDATE_PUBLIC_KEYS: ReadonlyMap<string, string> =
  new Map([
    [
      INTERNAL_BETA_UPDATE_KEY_ID,
      [
        "-----BEGIN PUBLIC KEY-----",
        "MCowBQYDK2VwAyEA66dsu/71MaWrv0zC7/0tRSYIhuFJ+AmiBE8vavq4Fe0=",
        "-----END PUBLIC KEY-----",
        "",
      ].join("\n"),
    ],
  ]);
