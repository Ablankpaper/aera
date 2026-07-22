export type OfficialAgentChannel = "internal" | "stable";

export function resolveOfficialAgentChannel(input: {
  isPackaged: boolean;
  environment: NodeJS.ProcessEnv;
}): OfficialAgentChannel {
  if (input.isPackaged) return "stable";
  const configured = input.environment.AGENTERA_OFFICIAL_AGENT_CHANNEL;
  if (configured === undefined || configured === "") return "internal";
  if (configured === "internal" || configured === "stable") return configured;
  throw new Error("Invalid official Agent channel.");
}
