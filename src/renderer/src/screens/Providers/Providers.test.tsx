import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Providers from "./Providers";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    setLocale: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock("../../components/common/BrandLogo", () => ({
  default: () => <span data-testid="brand-logo" />,
}));
vi.mock("../../components/OAuthLoginModal", () => ({
  default: () => <div>oauth-modal</div>,
}));
vi.mock("../../components/ProviderKeysSection", () => ({
  default: () => <div>provider-keys</div>,
}));
vi.mock("../../components/RegistryBrowserModal", () => ({
  default: () => <div>registry-modal</div>,
}));
vi.mock("../../components/AuxiliaryTasksSection", () => ({
  default: () => <div>auxiliary-tasks</div>,
}));
vi.mock("./ModelCenter", () => ({
  default: ({
    onEnvironmentChanged,
    onActivated,
  }: {
    onEnvironmentChanged?: () => void | Promise<void>;
    onActivated: (model: {
      provider: string;
      model: string;
      baseUrl: string;
    }) => void;
  }) => (
    <>
      <button type="button" onClick={() => void onEnvironmentChanged?.()}>
        model-center
      </button>
      <button
        type="button"
        onClick={() =>
          onActivated({
            provider: "custom:fixture",
            model: "fixture-model",
            baseUrl: "https://fixture.invalid/v1",
          })
        }
      >
        coordinated-activation
      </button>
    </>
  ),
}));
vi.mock("../../hooks/useDiscoveredModels", () => ({
  useDiscoveredModels: () => ({
    models: [],
    status: "idle",
    cached: false,
    freeModels: [],
  }),
}));

describe("Providers advanced settings", () => {
  const getAccount = vi.fn();
  const getEnv = vi.fn();

  beforeEach(() => {
    getAccount.mockReset();
    getEnv.mockReset();
    getEnv.mockResolvedValue({});
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getAccount,
        getEnv,
        getModelConfig: vi.fn(async () => ({
          provider: "auto",
          model: "",
          baseUrl: "",
        })),
        getCredentialPool: vi.fn(async () => ({})),
        listCustomProviders: vi.fn(async () => []),
        setModelConfig: vi.fn(async () => undefined),
        setEnv: vi.fn(async () => undefined),
        listModels: vi.fn(async () => []),
      },
    });
  });

  it("does not load or render the legacy Hermes One account surface", async () => {
    render(<Providers profile="fish" visible />);

    await waitFor(() =>
      expect(window.hermesAPI.getModelConfig).toHaveBeenCalled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /providers\.center\.advancedTab/ }),
    );

    expect(getAccount).not.toHaveBeenCalled();
    expect(
      screen.queryByText("providers.hermesAccount.sectionTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("providers.hermesAccount.signIn"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("providers.hermesAccount.signOut"),
    ).not.toBeInTheDocument();
  });

  it("reloads environment state after a coordinated model mutation", async () => {
    render(<Providers profile="fish" visible />);

    await waitFor(() => expect(getEnv).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "model-center" }));

    await waitFor(() => expect(getEnv).toHaveBeenCalledTimes(2));
    expect(getEnv).toHaveBeenLastCalledWith("fish");
  });

  // @lat: [[provider-setup#Active model is picked from configured providers#Coordinated activation suppresses legacy auto-save]]
  it("does not replay a coordinated activation through set-model-config", async () => {
    render(<Providers profile="fish" visible />);

    await waitFor(() =>
      expect(window.hermesAPI.getModelConfig).toHaveBeenCalled(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const setModelConfig = vi.mocked(window.hermesAPI.setModelConfig);
    setModelConfig.mockClear();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "coordinated-activation" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 650));
    });

    expect(setModelConfig).not.toHaveBeenCalled();
  });
});
