import { isAbsolute, join, resolve } from "node:path";

export interface PackagedRuntimeSeedPathOptions {
  isPackaged: boolean;
  resourcesPath: string;
  workingDirectory: string;
  developmentOverride?: string;
}

export function resolvePackagedRuntimeSeedDirectory(
  options: PackagedRuntimeSeedPathOptions,
): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, "agentera-runtime-seed");
  }

  const developmentOverride = options.developmentOverride?.trim();
  if (developmentOverride) {
    if (!isAbsolute(developmentOverride)) {
      throw new Error("AGENTERA_RUNTIME_SEED_DIR must be an absolute path");
    }
    return resolve(developmentOverride);
  }

  return join(options.workingDirectory, "resources", "agentera-runtime-seed");
}
