import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import SplashScreen from "./SplashScreen";

describe("SplashScreen", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  // @lat: [[agentera-branding#Naming contract#Visible application names]]
  it("shows the Aera wordmark without the Hermes image", () => {
    const onFinished = vi.fn();

    render(<SplashScreen onFinished={onFinished} />);

    expect(screen.getByText("Aera")).toHaveClass("splash-wordmark");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledOnce();
  });
});
