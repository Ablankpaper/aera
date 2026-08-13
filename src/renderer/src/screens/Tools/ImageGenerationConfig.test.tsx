import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationConfig } from "./ImageGenerationConfig";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const configured = {
  success: true as const,
  config: {
    enabled: true,
    provider: "openai" as const,
    baseUrl: "https://relay.example/v1",
    model: "gpt-image-1.5",
    quality: "medium" as const,
    aspectRatio: "square" as const,
    hasApiKey: true,
    status: "configured" as const,
  },
};

describe("ImageGenerationConfig", () => {
  const api = {
    getImageGenerationConfig: vi.fn(),
    saveImageGenerationConfig: vi.fn(),
    discoverImageGenerationModels: vi.fn(),
    testImageGeneration: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getImageGenerationConfig.mockResolvedValue(configured);
    api.saveImageGenerationConfig.mockResolvedValue(configured);
    api.discoverImageGenerationModels.mockResolvedValue({
      success: true,
      models: ["gpt-image-1.5", "gpt-image-2"],
    });
    api.testImageGeneration.mockResolvedValue({
      success: true,
      imageUrl: "data:image/png;base64,aW1hZ2U=",
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });
  });

  it("loads the requested Profile without exposing its existing key", async () => {
    render(<ImageGenerationConfig profile="design" />);

    expect(
      await screen.findByText("tools.imageGeneration.title"),
    ).toBeInTheDocument();
    expect(api.getImageGenerationConfig).toHaveBeenCalledWith("design");
    expect(screen.getByLabelText("tools.imageGeneration.apiKey")).toHaveValue(
      "",
    );
    expect(
      screen.getByText("tools.imageGeneration.keyConfigured"),
    ).toBeInTheDocument();
  });

  // @lat: [[image-generation#Local configuration disclosure]]
  it("collapses from the title button without changing enablement or unsaved values", async () => {
    render(<ImageGenerationConfig profile="design" />);
    const model = await screen.findByLabelText("tools.imageGeneration.model");
    const disclosure = screen.getByRole("button", {
      name: "tools.imageGeneration.title",
    });
    const enabled = screen.getByLabelText("tools.imageGeneration.enabled");

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(disclosure.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(model).toBeVisible();
    fireEvent.change(model, { target: { value: "unsaved-image-model" } });

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(model).not.toBeVisible();
    expect(enabled).toBeChecked();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(model).toBeVisible();
    expect(model).toHaveValue("unsaved-image-model");
  });

  it("keeps the enabled switch independent from disclosure", async () => {
    render(<ImageGenerationConfig profile="design" />);
    await screen.findByLabelText("tools.imageGeneration.model");
    const disclosure = screen.getByRole("button", {
      name: "tools.imageGeneration.title",
    });
    const enabled = screen.getByLabelText("tools.imageGeneration.enabled");

    fireEvent.click(enabled);

    expect(enabled).not.toBeChecked();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("saves the current draft without discovering or testing", async () => {
    render(<ImageGenerationConfig profile="design" />);
    await screen.findByDisplayValue("gpt-image-1.5");

    fireEvent.change(screen.getByLabelText("tools.imageGeneration.model"), {
      target: { value: "gpt-image-2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "tools.imageGeneration.save" }),
    );

    await waitFor(() =>
      expect(api.saveImageGenerationConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "",
          model: "gpt-image-2",
        }),
        "design",
      ),
    );
    expect(api.discoverImageGenerationModels).not.toHaveBeenCalled();
    expect(api.testImageGeneration).not.toHaveBeenCalled();
  });

  it("discovers models from the unsaved draft and selects a result", async () => {
    render(<ImageGenerationConfig profile="design" />);
    await screen.findByDisplayValue("gpt-image-1.5");

    fireEvent.change(screen.getByLabelText("tools.imageGeneration.apiKey"), {
      target: { value: "new-fixture-key" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "tools.imageGeneration.discover" }),
    );

    await waitFor(() =>
      expect(
        document.querySelector(
          '#image-generation-models option[value="gpt-image-2"]',
        ),
      ).toBeInTheDocument(),
    );
    expect(api.discoverImageGenerationModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "new-fixture-key" }),
      "design",
    );
  });

  // @lat: [[image-generation#One paid test request]]
  it("requires a second explicit click before one paid test request", async () => {
    render(<ImageGenerationConfig profile="design" />);
    await screen.findByDisplayValue("gpt-image-1.5");

    fireEvent.click(
      screen.getByRole("button", { name: "tools.imageGeneration.test" }),
    );

    expect(api.testImageGeneration).not.toHaveBeenCalled();
    expect(
      screen.getByText("tools.imageGeneration.testConfirmation"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "tools.imageGeneration.confirmTest",
      }),
    );

    await waitFor(() =>
      expect(api.testImageGeneration).toHaveBeenCalledTimes(1),
    );
    expect(api.testImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-image-1.5" }),
      "design",
    );
    expect(
      await screen.findByAltText("tools.imageGeneration.previewAlt"),
    ).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
  });

  it("maps stable Main error codes to localized copy", async () => {
    api.discoverImageGenerationModels.mockResolvedValue({
      success: false,
      errorCode: "upstream_rejected",
    });
    render(<ImageGenerationConfig profile="design" />);
    await screen.findByDisplayValue("gpt-image-1.5");

    fireEvent.click(
      screen.getByRole("button", { name: "tools.imageGeneration.discover" }),
    );

    expect(
      await screen.findByText("tools.imageGeneration.errors.upstream_rejected"),
    ).toBeInTheDocument();
  });

  // @lat: [[image-generation#Remote boundary]]
  it("renders the remote boundary without loading local Profile secrets", () => {
    render(<ImageGenerationConfig profile="design" remoteMode />);

    expect(
      screen.getByText("tools.imageGeneration.remoteUnsupported"),
    ).toBeInTheDocument();
    expect(api.getImageGenerationConfig).not.toHaveBeenCalled();
  });
});
