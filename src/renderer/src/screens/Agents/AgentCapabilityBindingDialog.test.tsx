import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentCapabilityBindingConfiguration } from "../../../../shared/agentera-agent-control";
import AgentCapabilityBindingDialog from "./AgentCapabilityBindingDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const configuration: AgentCapabilityBindingConfiguration = {
  installationId: "11111111-1111-4111-8111-111111111111",
  requirements: [
    {
      logicalName: "private-docs",
      tools: ["docs.read", "docs.search"],
      required: true,
      permissionReason: "Read employee-approved documents",
      mappedLocalMcpName: null,
      compatibleServers: [
        {
          mappingHandle: "22222222-2222-4222-8222-222222222222",
          displayName: "employee-docs",
          current: false,
        },
      ],
    },
    {
      logicalName: "calendar-optional",
      tools: ["calendar.read"],
      required: false,
      permissionReason: "Read an optional calendar",
      mappedLocalMcpName: null,
      compatibleServers: [],
    },
  ],
};

describe("AgentCapabilityBindingDialog", () => {
  it("shows only safe logical requirements and compatible local MCP names", () => {
    render(
      <AgentCapabilityBindingDialog
        open
        configuration={configuration}
        online
        busy={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "agents.capabilityBinding.title",
    });
    expect(dialog).toHaveTextContent("private-docs");
    expect(dialog).toHaveTextContent("docs.read");
    expect(dialog).toHaveTextContent("docs.search");
    expect(dialog).toHaveTextContent("Read employee-approved documents");
    expect(dialog).toHaveTextContent("employee-docs");
    expect(dialog).toHaveTextContent("calendar-optional");
    expect(dialog).not.toHaveTextContent("https://private.example.test");
    expect(dialog.textContent).not.toMatch(
      /command|args|env|header|token|auth/i,
    );
  });

  it("submits opaque mapping handles and permits an optional requirement to remain skipped", () => {
    const onConfirm = vi.fn();
    render(
      <AgentCapabilityBindingDialog
        open
        configuration={configuration}
        online
        busy={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "agents.capabilityBinding.title",
    });
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "private-docs" }),
      {
        target: { value: "22222222-2222-4222-8222-222222222222" },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "agents.capabilityBinding.save",
      }),
    );

    expect(onConfirm).toHaveBeenCalledWith({
      installationId: configuration.installationId,
      mappingHandles: ["22222222-2222-4222-8222-222222222222"],
      confirmation: "bind-profile-capabilities",
    });
  });
});
