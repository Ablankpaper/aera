import type { ModelCommandFormatter, SlashCommandDefinition } from "./types";
import {
  AGENTERA_GLOBAL_PROFILE_CATEGORIES,
  type AgenteraGlobalProfileCategory,
} from "../../../../../shared/agentera-global-profile";

const formatExplainSelection: ModelCommandFormatter = async (input) => ({
  content: [
    "Explain the following content clearly.",
    input.args && `Additional instructions:\n${input.args}`,
    input.selectedText && `Content:\n${input.selectedText}`,
  ]
    .filter(Boolean)
    .join("\n\n"),
  attachments: input.attachments,
});

// @lat: [[chat-commands#Slash command execution#Central command router#Desktop commands]]
export const DESKTOP_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: "global",
    description: "View or explicitly edit the account-wide behavior profile",
    category: "Desktop",
    argsHint:
      "show | set <category.key> <value> | remove <key> | history | rollback <version>",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: false,
    uiAction: true,
    execute: async ({ args }, context) => {
      const normalizedArgs = args.trim();
      if (!normalizedArgs || /^show$/iu.test(normalizedArgs)) {
        const result = await context.getGlobalProfile();
        if (!result.success) return { type: "error", message: result.error };
        if (result.value.entries.length === 0) {
          return {
            type: "handled",
            output: `**Global behavior profile · v${result.value.profileVersion}**\n\n_No confirmed behavior preferences yet._`,
          };
        }
        return {
          type: "handled",
          output: [
            `**Global behavior profile · v${result.value.profileVersion}**`,
            "",
            ...result.value.entries.map(
              (entry) => `- \`${entry.id}\` — ${entry.content}`,
            ),
          ].join("\n"),
        };
      }

      const setMatch = normalizedArgs.match(/^set\s+(\S+)\s+(.+)$/iu);
      if (setMatch) {
        const id = setMatch[1].toLowerCase();
        const category = id.split(".", 1)[0] as AgenteraGlobalProfileCategory;
        if (!AGENTERA_GLOBAL_PROFILE_CATEGORIES.includes(category)) {
          return {
            type: "error",
            message: `Category must be one of: ${AGENTERA_GLOBAL_PROFILE_CATEGORIES.join(", ")}`,
          };
        }
        const result = await context.setGlobalProfileEntry({
          id,
          category,
          content: setMatch[2],
        });
        return result.success
          ? {
              type: "handled",
              output: `Global behavior profile updated to v${result.value.profileVersion}. New conversations will use it; existing conversations keep their frozen snapshot.`,
            }
          : { type: "error", message: result.error };
      }

      const removeMatch = normalizedArgs.match(/^remove\s+(\S+)$/iu);
      if (removeMatch) {
        const result = await context.removeGlobalProfileEntry(removeMatch[1]);
        return result.success
          ? {
              type: "handled",
              output: `Global behavior profile updated to v${result.value.profileVersion}.`,
            }
          : { type: "error", message: result.error };
      }

      if (/^history$/iu.test(normalizedArgs)) {
        const result = await context.listGlobalProfileHistory();
        if (!result.success) return { type: "error", message: result.error };
        return {
          type: "handled",
          output:
            result.value.length === 0
              ? "_No global behavior profile history yet._"
              : [
                  "**Global behavior profile history**",
                  "",
                  ...result.value.map(
                    (item) =>
                      `- v${item.profileVersion} · ${item.entryCount} entries`,
                  ),
                ].join("\n"),
        };
      }

      const rollbackMatch = normalizedArgs.match(/^rollback\s+(\d+)$/iu);
      if (rollbackMatch) {
        const result = await context.rollbackGlobalProfile(
          Number(rollbackMatch[1]),
        );
        return result.success
          ? {
              type: "handled",
              output: `Global behavior profile restored as new version v${result.value.profileVersion}.`,
            }
          : { type: "error", message: result.error };
      }

      return {
        type: "error",
        message:
          "Usage: /global show | /global set <category.key> <value> | /global remove <key> | /global history | /global rollback <version>",
      };
    },
  },
  {
    name: "agent",
    description: "Manage the current Agent identity",
    category: "Desktop",
    argsHint: "name <new name>",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: false,
    uiAction: true,
    execute: async ({ args }, context) => {
      const match = args.match(/^name(?:\s+(.+))?$/iu);
      const displayName = match?.[1]?.trim() ?? "";
      if (!displayName) {
        return {
          type: "error",
          message: "Usage: /agent name <new name>",
        };
      }
      const result = await context.renameAgent(
        context.profile?.trim() || "default",
        displayName,
      );
      if (!result.success) {
        return {
          type: "error",
          message: result.error || "Agent identity update failed",
        };
      }
      return {
        type: "handled",
        output: `Agent renamed to “${displayName}”. The new identity is active now.`,
      };
    },
  },
  {
    name: "settings",
    description: "Open Desktop settings",
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    uiAction: true,
    execute: async ({ args }, context) => {
      context.openSettings(args || undefined);
      return { type: "handled" };
    },
  },
  {
    name: "explain-selection",
    description: "Explain the selected content",
    category: "Desktop",
    source: "desktop",
    target: "model",
    allowWhileBusy: false,
    supportsAttachments: true,
    format: formatExplainSelection,
  },
  {
    name: "help",
    aliases: ["commands"],
    description: "Show available commands",
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    execute: async (_input, context) => ({
      type: "handled",
      output: context.renderSlashHelp(),
    }),
  },
  {
    name: "model",
    description: "Open model picker",
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    uiAction: true,
    execute: async () => {
      window.dispatchEvent(new CustomEvent("model-picker:open"));
      return { type: "handled" };
    },
  },
  ...(
    [
      ["agents", "Open Agents page"],
      ["office", "Open Office 3D page"],
      ["discover", "Open Discover page"],
      ["providers", "Open Providers page"],
      ["schedules", "Open Schedules page"],
      ["kanban", "Open Kanban board"],
      ["gateway", "Open Gateway status page"],
    ] as const
  ).map(
    ([name, description]): SlashCommandDefinition => ({
      name,
      description,
      category: "Navigation",
      source: "desktop",
      target: "desktop",
      allowWhileBusy: true,
      uiAction: true,
      execute: async () => {
        window.dispatchEvent(
          new CustomEvent("navigation:goto", { detail: name }),
        );
        return { type: "handled" };
      },
    }),
  ),
];

// `uiAction: true` marks commands whose effect is a UI change with no
// transcript output (start a new chat, clear it, toggle fast mode) — the
// router suppresses their echoed `/command` user bubble.
const LOCAL_COMMANDS: ReadonlyArray<
  readonly [name: string, description: string, uiAction?: boolean]
> = [
  ["new", "Start a new chat", true],
  ["clear", "Clear conversation history", true],
  ["persona", "Show the current persona"],
  ["memory", "Show agent memory"],
  ["tools", "Show available toolsets"],
  ["skills", "Show installed skills"],
  ["version", "Show Aera Runtime version"],
  ["fast", "Toggle fast mode", true],
  ["usage", "Show token usage"],
];

export const LOCAL_DESKTOP_SLASH_COMMANDS: SlashCommandDefinition[] =
  LOCAL_COMMANDS.map(([name, description, uiAction]) => ({
    name,
    description,
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    ...(uiAction ? { uiAction: true } : {}),
    execute: async (input, context) => {
      const handled = await context.executeDesktopSlash(input.rawInput);
      return handled
        ? { type: "handled" as const }
        : {
            type: "error" as const,
            message: `Desktop command /${input.name} is unavailable`,
          };
    },
  }));
