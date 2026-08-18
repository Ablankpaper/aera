import type {
  ImageGenerationConfigDraft,
  ImageGenerationSaveResult,
} from "../shared/image-generation";

interface ImageGenerationRuntimeRefreshDependencies {
  save: (
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ) => ImageGenerationSaveResult | Promise<ImageGenerationSaveResult>;
  stopDashboard: (profile?: string) => unknown;
  retireTuiGatewayClient: (profile?: string) => Promise<void>;
  notifyRuntimeSnapshotChanged: (profile?: string) => void;
  isGatewayRunning: (profile?: string) => boolean;
  restartGateway: (profile?: string) => unknown;
}

interface ImageGenerationToolsetRefreshDependencies extends Omit<
  ImageGenerationRuntimeRefreshDependencies,
  "save"
> {
  setToolsetEnabled: (
    key: string,
    enabled: boolean,
    profile?: string,
  ) => boolean | Promise<boolean>;
}

async function refreshImageGenerationRuntime(
  profile: string | undefined,
  dependencies: Omit<ImageGenerationRuntimeRefreshDependencies, "save">,
): Promise<void> {
  dependencies.stopDashboard(profile);
  try {
    await dependencies.retireTuiGatewayClient(profile);
  } catch {
    // Persistence already succeeded; keep the public result truthful and let
    // the next snapshot/session start from the newly saved configuration.
  }
  dependencies.notifyRuntimeSnapshotChanged(profile);
  if (dependencies.isGatewayRunning(profile)) {
    void dependencies.restartGateway(profile);
  }
}

export async function saveImageGenerationConfigAndRefresh(
  profile: string | undefined,
  request: ImageGenerationConfigDraft,
  dependencies: ImageGenerationRuntimeRefreshDependencies,
): Promise<ImageGenerationSaveResult> {
  const result = await dependencies.save(profile, request);
  if (!result.success) return result;

  await refreshImageGenerationRuntime(profile, dependencies);
  return result;
}

export async function setToolsetEnabledAndRefreshImageGeneration(
  key: string,
  enabled: boolean,
  profile: string | undefined,
  dependencies: ImageGenerationToolsetRefreshDependencies,
): Promise<boolean> {
  const changed = await dependencies.setToolsetEnabled(key, enabled, profile);
  if (!changed || key !== "image_gen") return changed;

  await refreshImageGenerationRuntime(profile, dependencies);
  return changed;
}
