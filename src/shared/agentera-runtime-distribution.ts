export type RuntimeDistributionPhase =
  | "missing"
  | "installing"
  | "current"
  | "checking"
  | "update-available"
  | "downloading"
  | "candidate-ready"
  | "rollback"
  | "repair-required"
  | "external";

export interface RuntimeDistributionPublicState {
  phase: RuntimeDistributionPhase;
  currentVersion: string | null;
  currentSourceCommit: string | null;
  packagedSeedVersion: string | null;
  availableVersion: string | null;
  downloadSize: number | null;
  downloadPercent: number | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canCancel: boolean;
  canRestart: boolean;
}
