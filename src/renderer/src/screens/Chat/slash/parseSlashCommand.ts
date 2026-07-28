import type { ParsedSlashCommand } from "./types";

export type ParseSlashCommandResult =
  | { ok: true; command: ParsedSlashCommand }
  | { ok: false; error: string };

/**
 * Distinguishes slash commands from POSIX absolute paths pasted into a prompt.
 * Command names never contain "/", while paths such as
 * `/Volumes/work/project` do. Unknown one-segment commands still route through
 * the command error path so typos remain visible instead of reaching the model.
 */
export function isSlashCommandInput(rawInput: string): boolean {
  const trimmedStart = rawInput.trimStart();
  if (!trimmedStart.startsWith("/")) return false;
  const firstToken = trimmedStart.split(/\s+/, 1)[0];
  return !firstToken.slice(1).includes("/");
}

/**
 * Normalizes and splits raw input into command name and argument payload.
 */
export function parseSlashCommand(rawInput: string): ParseSlashCommandResult {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "Input is not a slash command" };
  }

  const withoutSlash = trimmed.slice(1);
  if (!withoutSlash.trim()) {
    return { ok: false, error: "Empty slash command" };
  }

  // Split on first whitespace sequence
  const match = withoutSlash.match(/^(\S+)(?:\s+(.*))?$/s);
  if (!match) {
    return { ok: false, error: "Invalid slash command format" };
  }

  const name = match[1];
  const args = match[2] ?? "";

  return {
    ok: true,
    command: {
      rawInput,
      name,
      normalizedName: name.toLowerCase(),
      args,
    },
  };
}
