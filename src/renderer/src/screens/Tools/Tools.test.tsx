import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Tools from "./Tools";

vi.mock("../../components/useI18n", () => ({
  useI18n: (() => {
    const t = (key: string): string => key;
    return () => ({ t });
  })(),
}));

vi.mock("../Skills/Skills", () => ({
  default: () => <div>skills</div>,
}));

vi.mock("./ImageGenerationConfig", () => ({
  ImageGenerationConfig: () => <div>image config</div>,
}));

describe("Tools toolset toggles", () => {
  const api = {
    getToolsets: vi.fn(),
    setToolsetEnabled: vi.fn(),
    listMcpServers: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getToolsets.mockResolvedValue([
      {
        key: "image_gen",
        label: "Image Generation",
        description: "Generate images",
        enabled: true,
      },
    ]);
    api.listMcpServers.mockResolvedValue([]);
    api.setToolsetEnabled.mockResolvedValue(false);
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });
  });

  // @lat: [[image-generation#Failed toggle reconciliation]]
  it("rolls back an optimistic toggle when Main rejects the write", async () => {
    render(<Tools profile="design" />);
    const toggle = await screen.findByRole("checkbox");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(api.setToolsetEnabled).toHaveBeenCalledWith(
        "image_gen",
        false,
        "design",
      ),
    );
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(screen.getByText("tools.toolsetToggleFailed")).toBeInTheDocument();
  });
});
