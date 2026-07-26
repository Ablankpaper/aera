export type AgenteraConnectionMode = "local" | "remote" | "ssh";
export type AgenteraPostAuthTarget = "welcome" | "setup" | "main";

export interface AgenteraInstallFileProbe {
  installed: boolean;
}

export interface AgenteraStartupPreflightPublicResult {
  connectionMode: AgenteraConnectionMode;
  postAuthTarget: AgenteraPostAuthTarget;
  verifyWarning: boolean;
}

export type AgenteraProfileClaimPublicState =
  | { status: "unbound"; meaningfulData: boolean }
  | {
      status: "owned";
      meaningfulData: boolean;
      isCurrentOwner: boolean;
      runtimeProfileId?: string;
    };

export interface AgenteraBoundProfilePublicState {
  status: "bound";
  runtimeProfileId: string;
}

export interface AgenteraResolvedProfilePublicState extends AgenteraBoundProfilePublicState {
  profileId: string;
}

export type AgenteraFreshProfilePublicState =
  AgenteraResolvedProfilePublicState;

export type AgenteraAccountProfileResolutionPublicState =
  | Extract<AgenteraProfileClaimPublicState, { status: "unbound" }>
  | AgenteraResolvedProfilePublicState;

export interface AgenteraUnboundProfilePublicState {
  id: string;
  isActive: boolean;
  meaningfulData: boolean;
}

export type AgenteraConnectionClaimPublicState =
  | { status: "unbound" }
  | { status: "owned"; isCurrentOwner: boolean };

export interface AgenteraBoundConnectionPublicState {
  status: "bound";
}
