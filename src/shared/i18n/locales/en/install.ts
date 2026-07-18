export default {
  preparing: "Preparing...",
  startingInstall: "Starting installation",
  preparingRuntime: "Preparing AgentEra Runtime",
  verifyingPackagedRuntime:
    "Verifying the Runtime included with AgentEra Studio",
  installationComplete: "AgentEra Runtime Is Ready",
  installationFailed: "Runtime Preparation Failed",
  installingHermes: "Installing AgentEra Runtime",
  installationFailedHint:
    "Installation failed. Please try again or install via terminal.",
  preparationFailedHint:
    "AgentEra Runtime could not be prepared from the local installer resources.",
  packagedRuntimeInvalid:
    "The Runtime included with AgentEra Studio is missing or invalid. Reinstall AgentEra Studio; no online fallback was used.",
  insufficientDiskSpace:
    "There is not enough free disk space to prepare AgentEra Runtime. Free some space and try again.",
  retryInstallation: "Retry Installation",
  retryPreparation: "Retry Preparation",
  reinstallDesktop: "Reinstall AgentEra Studio",
  copied: "Copied!",
  copyLogs: "Copy Logs",
  stepLabel: "Step {{step}}/{{total}}: {{title}}",
  waitingToStart: "Waiting to start...",
  continueToSetup: "Continue to Setup",
  confirmTitle: "Prepare AgentEra Runtime",
  confirmBundledRuntime:
    "AgentEra Runtime is already included with this desktop app and will be prepared locally.",
  confirmOfflinePreparation:
    "This first preparation does not download Hermes from GitHub and does not change your Profile, Memory, sessions, or learned Skills.",
  confirmPrepareBtn: "Prepare Runtime",
  confirmLocationLabel: "AgentEra will be installed at:",
  confirmFresh:
    "No existing installation was found here — a fresh copy will be set up.",
  confirmUpdate:
    "An existing AgentEra installation is here — it will be updated to the latest version.",
  confirmReplace:
    "A folder exists here but isn't a valid AgentEra installation — installing will delete and replace it.",
  confirmNotInherited:
    "If you installed AgentEra somewhere else, or via the command line, it won't be carried over.",
  confirmInstallBtn: "Install AgentEra",
  useExistingBtn: "Use an existing installation",
  useExistingHint:
    "Select the folder that holds your existing AgentEra installation (the one containing the hermes-agent folder).",
  useExistingInvalid:
    "No usable AgentEra installation was found in that folder.",
  useExistingDone:
    "Existing installation set — quit and reopen AgentEra to apply it.",
  useExistingQuitBtn: "Quit AgentEra",
} as const;
