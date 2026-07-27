const INTERNAL_BETA_VERSION_PATTERN = /^\d+\.\d+\.\d+-internal-beta\.\d+$/;

export function isInternalBetaDesktopVersion(version: string): boolean {
  return INTERNAL_BETA_VERSION_PATTERN.test(version.trim());
}
