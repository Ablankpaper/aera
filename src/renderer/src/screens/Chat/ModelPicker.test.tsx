import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
  Check: () => null,
  Asterisk: () => null,
}));

vi.mock("../../components/common/BrandLogo", () => ({
  default: () => null,
}));

import { ModelPicker } from "./ModelPicker";
import type { ModelGroup } from "./types";
import type { AgentConversationModelContext } from "../../../../shared/model-configuration";

const groups: ModelGroup[] = [
  {
    provider: "openrouter",
    providerLabel: "providers.openrouter",
    models: [
      {
        provider: "openrouter",
        model: "owl-alpha",
        label: "OWL Alpha",
        baseUrl: "",
      },
      {
        provider: "openrouter",
        model: "owl-beta",
        label: "OWL Beta",
        baseUrl: "",
      },
    ],
  },
  {
    provider: "ollama",
    providerLabel: "providers.ollama",
    models: [
      {
        provider: "ollama",
        model: "llama3",
        label: "Llama 3",
        baseUrl: "http://localhost:11434",
      },
    ],
  },
];

/** Render helper that also returns the container for scoped DOM queries. */
function renderPicker(
  overrides: {
    active?: boolean;
    currentModel?: string;
    currentProvider?: string;
    currentBaseUrl?: string;
    modelGroups?: ModelGroup[];
    displayModel?: string;
    onOpen?: () => void;
    onSelectModel?: (provider: string, model: string, baseUrl: string) => void;
    agentConversation?: AgentConversationModelContext | null;
    onSelectAgentModel?: (selection: {
      sourceProfileId: string;
      modelLibraryId: string;
      catalogRevision: string;
    }) => void;
    agentSwitchState?: "idle" | "pending" | "preparing" | "active" | "failed";
  } = {},
): {
  container: HTMLElement;
  unmount: () => void;
  onOpen: Mock;
  onSelectModel: Mock;
} {
  const onOpen = vi.fn();
  const onSelectModel = vi.fn();
  const utils = render(
    <ModelPicker
      active={overrides.active}
      currentModel={overrides.currentModel ?? "owl-alpha"}
      currentProvider={overrides.currentProvider ?? "openrouter"}
      currentBaseUrl={overrides.currentBaseUrl ?? ""}
      modelGroups={overrides.modelGroups ?? groups}
      displayModel={overrides.displayModel ?? "OWL Alpha"}
      onOpen={overrides.onOpen ?? onOpen}
      onSelectModel={overrides.onSelectModel ?? onSelectModel}
      agentConversation={overrides.agentConversation}
      onSelectAgentModel={overrides.onSelectAgentModel}
      agentSwitchState={overrides.agentSwitchState}
    />,
  );
  return { ...utils, onOpen, onSelectModel };
}

/** Click the trigger button (scoped to container to avoid ambiguity) and
 *  return the dropdown element for `within()` scoping. */
function openPicker(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector(
    ".chat-model-trigger",
  ) as HTMLButtonElement;
  fireEvent.click(trigger);
  return container.querySelector(".chat-model-dropdown") as HTMLElement;
}

describe("ModelPicker", () => {
  const agentContext: AgentConversationModelContext = {
    threadId: "thread-1",
    policyMode: "user_select",
    activeRoute: {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
    },
    activeSegmentOrdinal: 1,
    catalog: {
      revision: "a".repeat(64),
      targetProfileId: "account",
      routes: [
        {
          id: "openai\0gpt-5.6",
          provider: "openai",
          model: "gpt-5.6",
          baseUrl: "https://api.openai.com/v1",
          apiMode: "responses",
          providerLabel: "providers.openai",
          displayName: "GPT-5.6",
          sourceProfileId: "account",
          sourceKind: "account",
          selection: {
            sourceProfileId: "account",
            modelLibraryId: "openai-gpt-5.6",
            catalogRevision: "a".repeat(64),
          },
        },
        {
          id: "petoi\0gpt-5.6-sol",
          provider: "custom:petoi",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.petoi.cn/v1",
          apiMode: "codex_responses",
          providerLabel: "Petoi",
          displayName: "Petoi Sol",
          sourceProfileId: "account",
          sourceKind: "account",
          selection: {
            sourceProfileId: "account",
            modelLibraryId: "petoi-gpt",
            catalogRevision: "a".repeat(64),
          },
        },
      ],
    },
    switchDisabledCode: null,
  };

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#User-selected staged selection]]
  it("stages an installed-Agent selection without invoking ordinary session override selection", () => {
    const onSelectAgentModel = vi.fn();
    const { container, onSelectModel } = renderPicker({
      agentConversation: agentContext,
      onSelectAgentModel,
    });
    const dropdown = openPicker(container);

    fireEvent.click(within(dropdown).getByText("Petoi Sol"));

    expect(onSelectAgentModel).toHaveBeenCalledWith(
      agentContext.catalog.routes[1].selection,
    );
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("keeps the picker enabled for an Agent carrying a legacy fixed policy", () => {
    const onSelectAgentModel = vi.fn();
    const { container } = renderPicker({
      agentConversation: {
        ...agentContext,
        policyMode: "fixed",
        switchDisabledCode: "model_switch_fixed_policy",
      },
      onSelectAgentModel,
    });
    const trigger = container.querySelector(
      ".chat-model-trigger",
    ) as HTMLButtonElement;

    expect(trigger.disabled).toBe(false);
    const dropdown = openPicker(container);
    fireEvent.click(within(dropdown).getByText("Petoi Sol"));
    expect(onSelectAgentModel).toHaveBeenCalledWith(
      agentContext.catalog.routes[1].selection,
    );
    expect(container.textContent).not.toContain("chat.modelSwitch.fixedPolicy");
  });

  it("explains next-message, preparing, and failure-retention states", () => {
    const pending = renderPicker({
      agentConversation: agentContext,
      agentSwitchState: "pending",
    });
    expect(pending.container.textContent).toContain(
      "chat.modelSwitch.nextMessage",
    );
    pending.unmount();

    const preparing = renderPicker({
      agentConversation: agentContext,
      agentSwitchState: "preparing",
    });
    expect(preparing.container.textContent).toContain(
      "chat.modelSwitch.preparing",
    );
    preparing.unmount();

    const failed = renderPicker({
      agentConversation: agentContext,
      displayModel: "GPT-5.6",
      agentSwitchState: "failed",
    });
    expect(failed.container.textContent).toContain(
      "chat.modelSwitch.failedKeepsCurrent",
    );
    expect(
      failed.container.querySelector(".chat-model-name")?.textContent,
    ).toBe("GPT-5.6");
  });

  // ── initial render ──────────────────────────────────────────────
  it("renders the display model name in the trigger button", () => {
    const { container } = renderPicker({ displayModel: "OWL Alpha" });
    const trigger = container.querySelector(".chat-model-trigger")!;
    expect(trigger.querySelector(".chat-model-name")?.textContent).toBe(
      "OWL Alpha",
    );
  });

  it("does not show the dropdown initially", () => {
    const { container } = renderPicker();
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  // ── open / close ────────────────────────────────────────────────
  it("opens the dropdown and calls onOpen when the trigger is clicked", () => {
    const { container, onOpen } = renderPicker();
    openPicker(container);
    expect(screen.getByPlaceholderText("chat.searchModels")).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("closes the dropdown when the trigger is clicked again", () => {
    const { container } = renderPicker();
    const trigger = container.querySelector(
      ".chat-model-trigger",
    ) as HTMLButtonElement;
    fireEvent.click(trigger); // open
    fireEvent.click(trigger); // close
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  it("closes the dropdown when clicking outside", () => {
    const { container } = renderPicker();
    openPicker(container);
    fireEvent.mouseDown(document.body);
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  it("closes the dropdown when pressing Escape", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);
    fireEvent.keyDown(dropdown, { key: "Escape" });
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  it("opens from a slash-command event only when the chat is active", () => {
    const active = renderPicker({ active: true });
    const inactive = renderPicker({ active: false });

    act(() => {
      window.dispatchEvent(new CustomEvent("model-picker:open"));
    });

    expect(
      active.container.querySelector(".chat-model-dropdown"),
    ).not.toBeNull();
    expect(inactive.container.querySelector(".chat-model-dropdown")).toBeNull();
    expect(active.onOpen).toHaveBeenCalledTimes(1);
    expect(inactive.onOpen).not.toHaveBeenCalled();
  });

  // ── model list rendering ────────────────────────────────────────
  it("renders all provider groups and their models", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);

    expect(within(dropdown).getByText("providers.openrouter")).toBeTruthy();
    expect(within(dropdown).getByText("providers.ollama")).toBeTruthy();
    expect(within(dropdown).getByText("OWL Alpha")).toBeTruthy();
    expect(within(dropdown).getByText("OWL Beta")).toBeTruthy();
    expect(within(dropdown).getByText("Llama 3")).toBeTruthy();
  });

  it("marks the active model with the 'active' class", () => {
    const { container } = renderPicker({
      currentModel: "owl-alpha",
      currentProvider: "openrouter",
    });
    const dropdown = openPicker(container);

    const option = within(dropdown).getByText("OWL Alpha").closest("button");
    expect(option?.className).toContain("active");
  });

  it("orders the currently-selected model first in the list", () => {
    // Llama 3 is in the second group; selecting it should hoist it to the top.
    const { container } = renderPicker({
      currentModel: "llama3",
      currentProvider: "ollama",
      currentBaseUrl: "http://localhost:11434",
    });
    const dropdown = openPicker(container);
    const titles = Array.from(
      dropdown.querySelectorAll(".chat-model-row-title"),
    ).map((el) => el.textContent);
    expect(titles[0]).toBe("Llama 3");
  });

  it("does not mark an inactive model as active", () => {
    const { container } = renderPicker({
      currentModel: "owl-alpha",
      currentProvider: "openrouter",
    });
    const dropdown = openPicker(container);

    const betaOption = within(dropdown).getByText("OWL Beta").closest("button");
    expect(betaOption?.className).not.toContain("active");
  });

  // ── model selection ─────────────────────────────────────────────
  it("calls onSelectModel with correct args when a model is clicked", () => {
    const { container, onSelectModel } = renderPicker();
    const dropdown = openPicker(container);

    fireEvent.click(within(dropdown).getByText("Llama 3"));

    expect(onSelectModel).toHaveBeenCalledWith(
      "ollama",
      "llama3",
      "http://localhost:11434",
    );
  });

  it("closes the dropdown after selecting a model", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);

    fireEvent.click(within(dropdown).getByText("OWL Beta"));
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  // ── search / filtering ──────────────────────────────────────────
  it("filters models by label (case-insensitive)", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);
    const search = within(dropdown).getByPlaceholderText("chat.searchModels");

    fireEvent.change(search, { target: { value: "beta" } });

    expect(within(dropdown).queryByText("OWL Alpha")).toBeNull();
    expect(within(dropdown).getByText("OWL Beta")).toBeTruthy();
    expect(within(dropdown).queryByText("Llama 3")).toBeNull();
  });

  it("filters models by model id", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);
    const search = within(dropdown).getByPlaceholderText("chat.searchModels");

    fireEvent.change(search, { target: { value: "llama3" } });

    expect(within(dropdown).queryByText("OWL Alpha")).toBeNull();
    expect(within(dropdown).getByText("Llama 3")).toBeTruthy();
  });

  it("shows all models when search is cleared", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);
    const search = within(dropdown).getByPlaceholderText("chat.searchModels");

    fireEvent.change(search, { target: { value: "beta" } });
    fireEvent.change(search, { target: { value: "" } });

    expect(within(dropdown).getByText("OWL Alpha")).toBeTruthy();
    expect(within(dropdown).getByText("Llama 3")).toBeTruthy();
  });

  it("clears search when the dropdown is toggled closed", () => {
    const { container } = renderPicker();
    const trigger = container.querySelector(
      ".chat-model-trigger",
    ) as HTMLButtonElement;

    fireEvent.click(trigger); // open
    const search = container.querySelector(
      ".chat-model-search-input",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "beta" } });
    expect(search.value).toBe("beta");

    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // re-open

    const searchAfter = container.querySelector(
      ".chat-model-search-input",
    ) as HTMLInputElement;
    expect(searchAfter.value).toBe("");
  });

  // ── provider rail ───────────────────────────────────────────────
  it("filters the model list to the clicked provider rail item", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);

    // Click the Ollama rail entry (its label is rendered in the left rail).
    const ollamaRail = within(dropdown)
      .getByText("providers.ollama")
      .closest("button")!;
    fireEvent.click(ollamaRail);

    expect(within(dropdown).getByText("Llama 3")).toBeTruthy();
    expect(within(dropdown).queryByText("OWL Alpha")).toBeNull();
    expect(within(dropdown).queryByText("OWL Beta")).toBeNull();
  });

  // ── configure providers/models footer ───────────────────────────
  it("navigates to the Providers screen and closes when Configure is clicked", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);

    const goto = vi.fn();
    window.addEventListener("navigation:goto", goto);
    try {
      fireEvent.click(within(dropdown).getByText("chat.configure"));
    } finally {
      window.removeEventListener("navigation:goto", goto);
    }

    expect(goto).toHaveBeenCalledTimes(1);
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toBe("providers");
    expect(container.querySelector(".chat-model-dropdown")).toBeNull();
  });

  // ── edge cases ──────────────────────────────────────────────────
  it("shows the empty state and configure button when modelGroups is empty", () => {
    const { container } = renderPicker({ modelGroups: [] });
    const dropdown = openPicker(container);
    expect(within(dropdown).getByText("chat.configure")).toBeTruthy();
    expect(within(dropdown).getByText("chat.noModelsMatch")).toBeTruthy();
    expect(within(dropdown).queryByText("providers.openrouter")).toBeNull();
  });

  it("renders nothing when search matches no models", () => {
    const { container } = renderPicker();
    const dropdown = openPicker(container);
    const search = within(dropdown).getByPlaceholderText("chat.searchModels");

    fireEvent.change(search, { target: { value: "zzzznonexistent" } });

    expect(within(dropdown).queryByText("OWL Alpha")).toBeNull();
    expect(within(dropdown).queryByText("Llama 3")).toBeNull();
  });
});
