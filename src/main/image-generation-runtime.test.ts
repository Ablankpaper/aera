// @vitest-environment node

import { describe, expect, it, vi, type Mock } from "vitest";
import type {
  ImageGenerationConfigDraft,
  ImageGenerationSaveResult,
} from "../shared/image-generation";
import {
  saveImageGenerationConfigAndRefresh,
  setToolsetEnabledAndRefreshImageGeneration,
} from "./image-generation-runtime";

const profile = "work";
const draft: ImageGenerationConfigDraft = {
  enabled: true,
  baseUrl: "https://relay.example/v1",
  apiKey: "fixture-secret",
  model: "gpt-image-1.5",
  quality: "medium",
  aspectRatio: "square",
};

function successResult(): ImageGenerationSaveResult {
  return {
    success: true,
    config: {
      enabled: true,
      provider: "openai",
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-1.5",
      quality: "medium",
      aspectRatio: "square",
      hasApiKey: true,
      status: "configured",
    },
  };
}

type SaveConfig = (
  profile: string | undefined,
  request: ImageGenerationConfigDraft,
) => ImageGenerationSaveResult;
type StopDashboard = (profile?: string) => void;
type RetireTuiGatewayClient = (profile?: string) => Promise<void>;
type NotifyRuntimeSnapshotChanged = (profile?: string) => void;
type IsGatewayRunning = (profile?: string) => boolean;
type RestartGateway = (profile?: string) => Promise<boolean>;
type SetToolsetEnabled = (
  key: string,
  enabled: boolean,
  profile?: string,
) => boolean;

interface RuntimeTestDependencies {
  save: Mock<SaveConfig>;
  stopDashboard: Mock<StopDashboard>;
  retireTuiGatewayClient: Mock<RetireTuiGatewayClient>;
  notifyRuntimeSnapshotChanged: Mock<NotifyRuntimeSnapshotChanged>;
  isGatewayRunning: Mock<IsGatewayRunning>;
  restartGateway: Mock<RestartGateway>;
}

interface ToolsetTestDependencies extends Omit<
  RuntimeTestDependencies,
  "save"
> {
  setToolsetEnabled: Mock<SetToolsetEnabled>;
}

const dependencies = (): RuntimeTestDependencies => ({
  save: vi.fn<SaveConfig>(() => successResult()),
  stopDashboard: vi.fn<StopDashboard>(),
  retireTuiGatewayClient: vi.fn<RetireTuiGatewayClient>(async () => undefined),
  notifyRuntimeSnapshotChanged: vi.fn<NotifyRuntimeSnapshotChanged>(),
  isGatewayRunning: vi.fn<IsGatewayRunning>(() => true),
  restartGateway: vi.fn<RestartGateway>(async () => true),
});

const toolsetDependencies = (): ToolsetTestDependencies => ({
  setToolsetEnabled: vi.fn<SetToolsetEnabled>(() => true),
  stopDashboard: vi.fn<StopDashboard>(),
  retireTuiGatewayClient: vi.fn<RetireTuiGatewayClient>(async () => undefined),
  notifyRuntimeSnapshotChanged: vi.fn<NotifyRuntimeSnapshotChanged>(),
  isGatewayRunning: vi.fn<IsGatewayRunning>(() => false),
  restartGateway: vi.fn<RestartGateway>(async () => true),
});

describe("image generation Runtime refresh", () => {
  it("retires the saved Profile snapshot before notifying active conversations", async () => {
    const deps = dependencies();

    const result = await saveImageGenerationConfigAndRefresh(
      profile,
      draft,
      deps,
    );

    expect(result).toEqual(successResult());
    expect(deps.save).toHaveBeenCalledWith(profile, draft);
    expect(deps.stopDashboard).toHaveBeenCalledWith(profile);
    expect(deps.retireTuiGatewayClient).toHaveBeenCalledWith(profile);
    expect(deps.notifyRuntimeSnapshotChanged).toHaveBeenCalledWith(profile);
    expect(deps.isGatewayRunning).toHaveBeenCalledWith(profile);
    expect(deps.restartGateway).toHaveBeenCalledWith(profile);
    expect(
      deps.retireTuiGatewayClient.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deps.notifyRuntimeSnapshotChanged.mock.invocationCallOrder[0],
    );
  });

  it("does not disturb a Runtime snapshot when persistence fails", async () => {
    const deps = dependencies();
    deps.save.mockReturnValue({
      success: false,
      errorCode: "invalid_configuration",
    });

    const result = await saveImageGenerationConfigAndRefresh(
      profile,
      draft,
      deps,
    );

    expect(result).toEqual({
      success: false,
      errorCode: "invalid_configuration",
    });
    expect(deps.stopDashboard).not.toHaveBeenCalled();
    expect(deps.retireTuiGatewayClient).not.toHaveBeenCalled();
    expect(deps.notifyRuntimeSnapshotChanged).not.toHaveBeenCalled();
    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  it("does not start a Gateway that was not already running", async () => {
    const deps = dependencies();
    deps.isGatewayRunning.mockReturnValue(false);

    await saveImageGenerationConfigAndRefresh(profile, draft, deps);

    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  // @lat: [[image-generation#Runtime snapshot refresh]]
  it("keeps a committed save successful when an old TUI Runtime cannot retire", async () => {
    const deps = dependencies();
    deps.retireTuiGatewayClient.mockRejectedValue(
      new Error("fixture retirement failure"),
    );

    const result = await saveImageGenerationConfigAndRefresh(
      profile,
      draft,
      deps,
    );

    expect(result).toEqual(successResult());
    expect(deps.notifyRuntimeSnapshotChanged).toHaveBeenCalledWith(profile);
    expect(deps.isGatewayRunning).toHaveBeenCalledWith(profile);
    expect(deps.restartGateway).toHaveBeenCalledWith(profile);
  });

  it("refreshes the active Profile after its image tool card is toggled", async () => {
    const deps = toolsetDependencies();

    const result = await setToolsetEnabledAndRefreshImageGeneration(
      "image_gen",
      false,
      profile,
      deps,
    );

    expect(result).toBe(true);
    expect(deps.setToolsetEnabled).toHaveBeenCalledWith(
      "image_gen",
      false,
      profile,
    );
    expect(deps.stopDashboard).toHaveBeenCalledWith(profile);
    expect(deps.retireTuiGatewayClient).toHaveBeenCalledWith(profile);
    expect(deps.notifyRuntimeSnapshotChanged).toHaveBeenCalledWith(profile);
  });

  it("leaves Runtime snapshots alone for other cards or failed writes", async () => {
    const otherTool = toolsetDependencies();
    const failedImageWrite = toolsetDependencies();
    failedImageWrite.setToolsetEnabled.mockReturnValue(false);

    await setToolsetEnabledAndRefreshImageGeneration(
      "web",
      false,
      profile,
      otherTool,
    );
    await setToolsetEnabledAndRefreshImageGeneration(
      "image_gen",
      false,
      profile,
      failedImageWrite,
    );

    expect(otherTool.retireTuiGatewayClient).not.toHaveBeenCalled();
    expect(failedImageWrite.retireTuiGatewayClient).not.toHaveBeenCalled();
  });
});
