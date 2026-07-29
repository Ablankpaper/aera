export default {
  preparing: "Preparing...",
  preparingRuntime: "Preparing Aera Runtime",
  verifyingPackagedRuntime:
    "Verifying the Runtime included with Aera",
  installationComplete: "Aera Runtime Is Ready",
  installationFailed: "Runtime Preparation Failed",
  preparationFailedHint:
    "Aera Runtime could not be prepared from the local installer resources.",
  packagedRuntimeInvalid:
    "The Runtime included with Aera is missing or invalid. Reinstall Aera; no online fallback was used.",
  insufficientDiskSpace:
    "There is not enough free disk space to prepare Aera Runtime. Free some space and try again.",
  retryPreparation: "Retry Preparation",
  reinstallDesktop: "Reinstall Aera",
  copied: "Copied!",
  copyLogs: "Copy Logs",
  stepLabel: "Step {{step}}/{{total}}: {{title}}",
  waitingToStart: "Waiting to start...",
  continueToSetup: "Continue to Setup",
  confirmTitle: "Prepare Aera Runtime",
  confirmBundledRuntime:
    "Aera Runtime is already included with this desktop app and will be prepared locally.",
  confirmOfflinePreparation:
    "This first preparation does not download Aera Runtime from GitHub and does not change your Agent data, Memory, sessions, or learned Skills.",
  confirmPrepareBtn: "Prepare Runtime",
  useExistingBtn: "Use existing external Runtime",
  useExistingHint:
    "Select the Aera Runtime home containing hermes-agent. This Runtime remains external and unmanaged; updates run only through that checkout's local command.",
  useExistingInvalid:
    "No usable external Aera Runtime was found in that folder.",
  useExistingDone:
    "External Runtime selected — quit and reopen Aera to apply it. Aera will not modify or delete that checkout.",
  useExistingQuitBtn: "Quit Aera",
} as const;
