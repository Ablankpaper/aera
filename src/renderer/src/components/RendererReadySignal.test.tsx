import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RendererReadySignal from "./RendererReadySignal";

const originalHermesAPI = window.hermesAPI;

afterEach(() => {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: originalHermesAPI,
  });
});

describe("RendererReadySignal", () => {
  it("signals health only after React commits the component", async () => {
    const markRendererReady = vi.fn(async () => true);
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { markRendererReady },
    });

    render(<RendererReadySignal />);

    await waitFor(() => expect(markRendererReady).toHaveBeenCalledOnce());
  });
});
