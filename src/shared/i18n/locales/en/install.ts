export default {
  preparing: "Preparing...",
  preparingRuntime: "Preparing AgentEra Runtime",
  verifyingPackagedRuntime:
    "Verifying the Runtime included with AgentEra Studio",
  installationComplete: "AgentEra Runtime Is Ready",
  installationFailed: "Runtime Preparation Failed",
  preparationFailedHint:
    "AgentEra Runtime could not be prepared from the local installer resources.",
  packagedRuntimeInvalid:
    "The Runtime included with AgentEra Studio is missing or invalid. Reinstall AgentEra Studio; no online fallback was used.",
  insufficientDiskSpace:
    "There is not enough free disk space to prepare AgentEra Runtime. Free some space and try again.",
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
  useExistingBtn: "Use existing external Runtime",
  useExistingHint:
    "Select the Hermes home containing hermes-agent. This Runtime remains external and unmanaged; updates run only through that checkout's local command.",
  useExistingInvalid:
    "No usable external AgentEra Runtime was found in that folder.",
  useExistingDone:
    "External Runtime selected — quit and reopen AgentEra to apply it. AgentEra Studio will not modify or delete that checkout.",
  useExistingQuitBtn: "Quit AgentEra",
} as const;
