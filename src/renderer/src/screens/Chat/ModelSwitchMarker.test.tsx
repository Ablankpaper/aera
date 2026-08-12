import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSwitchMarker } from "./ModelSwitchMarker";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("ModelSwitchMarker", () => {
  it("renders a non-prompt marker with the old and new model identities", () => {
    render(
      <ModelSwitchMarker
        message={{
          id: "switch-1",
          kind: "model_switch",
          role: "agent",
          from: {
            provider: "openai",
            model: "gpt-5.6",
            baseUrl: "https://api.openai.com/v1",
            apiMode: "responses",
          },
          to: {
            provider: "custom:petoi",
            model: "gpt-5.6-sol",
            baseUrl: "https://api.petoi.cn/v1",
            apiMode: "codex_responses",
          },
          segmentId: "segment-2",
          localOnly: true,
        }}
      />,
    );

    expect(screen.getByTestId("model-switch-marker")).toBeVisible();
    expect(screen.getByText("gpt-5.6")).toBeVisible();
    expect(screen.getByText("gpt-5.6-sol")).toBeVisible();
    expect(screen.getByText("chat.modelSwitch.marker")).toBeVisible();
  });
});
