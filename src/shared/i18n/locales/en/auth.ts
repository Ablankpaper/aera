const auth = {
  gate: {
    title: "Sign in to AgentEra",
    checking: "Checking your AgentEra session…",
    browserNote:
      "Registration, sign-in, and password recovery open securely in your browser. AgentEra Studio never collects your password or verification code.",
    openBrowser: "Open browser to sign in or register",
    waitingForBrowser: "Waiting for browser authorization…",
    cancel: "Cancel",
    retry: "Retry",
    retrying: "Checking again…",
    loginFailed: "Browser authorization did not finish. Please try again.",
    retryFailed: "AgentEra could not verify your session. Please try again.",
    cancelled: "Browser authorization was cancelled.",
    secureStorageTitle: "Secure storage is unavailable",
    secureStorageDescription:
      "AgentEra cannot safely store this device session. Enable your system keychain or credential service, then retry. Plaintext storage is never used.",
    reasons: {
      sign_in_required:
        "Sign in or create an account before using AgentEra Studio.",
      offline_expired:
        "Your seven-day offline access has expired. Connect to the internet and sign in again.",
      clock_rollback:
        "The system clock changed unexpectedly. Connect to the internet to verify this device.",
      device_revoked:
        "This device is no longer authorized. Sign in to authorize it again.",
      account_disabled:
        "This AgentEra account is currently disabled. Use the browser account page for help.",
      account_pending_deletion:
        "This account is pending deletion and cannot authorize AgentEra Studio.",
      secure_storage_unavailable:
        "Secure system storage is required for AgentEra sessions.",
    },
  },
  profile: {
    checkingTitle: "Checking local data access",
    checkingDescription:
      "AgentEra is checking ownership metadata without opening your private Runtime content.",
    title: "Choose how to use your local data",
    existingDescription:
      "Existing AgentEra Runtime data was found on this device. Choose whether to bind it in place or start with a separate empty space.",
    noUpload:
      "Neither choice uploads, copies, merges, or rewrites your Memory, sessions, files, skills, USER profile, or learning state.",
    useExisting: "Use existing local data",
    createNew: "Create a new space",
    binding: "Binding securely…",
    creating: "Creating an empty space…",
    emptyBindingTitle: "Preparing your personal space",
    emptyBindingDescription:
      "This empty local Profile is being bound to your AgentEra account.",
    connectionBindingTitle: "Securing this Runtime connection",
    connectionBindingDescription:
      "The remote or SSH connection is being bound to the signed-in AgentEra owner. Product tokens are not sent to the Runtime.",
    otherOwnerTitle: "This local data belongs to another account",
    otherOwnerDescription:
      "AgentEra will not open or reassign this physical Profile. Create a separate empty space or sign in with its owner.",
    remoteOtherOwnerTitle: "This Runtime connection belongs to another account",
    remoteOtherOwnerDescription:
      "AgentEra will not inherit the previous owner's remote or SSH connection context.",
    differentAccount: "Sign in with a different account",
    failedTitle: "Local access could not be prepared",
    failedDescription:
      "No private Runtime data was changed. Retry the ownership check when you are ready.",
    retry: "Retry ownership check",
  },
  offline: {
    title: "Local offline mode",
    description:
      "Cloud account features are paused. Local Agent work, model APIs, and Hermes learning remain available until the signed offline deadline.",
  },
  account: {
    settingsNav: "AgentEra account",
    title: "AgentEra account",
    openMenu: "Open AgentEra account menu",
    online: "Online · verified",
    offline: "Offline · local access",
    manage: "Manage account",
    devices: "Manage devices",
    recharge: "Recharge model API",
    switch: "Switch account",
    signOut: "Sign out",
    actionFailed: "This account action could not be completed.",
    unavailable: "AgentEra account information is unavailable.",
    userId: "User",
    deviceId: "Device",
    offlineUntil: "Signed offline access is valid until {{date}}.",
    localDataWarning:
      "Deleting or signing out of the cloud account does not delete, move, upload, or unbind local Hermes Profiles, Memory, sessions, files, skills, or learning state.",
    rechargeSeparateAccount:
      "Recharge opens the independent model API website. Its accounts, balances, API keys, cookies, and tokens are separate from this AgentEra account.",
    pendingRevocationWarning:
      "If you sign out while the control plane is unreachable, this device may still count toward the five-device limit until the signed self-revocation is delivered automatically.",
  },
};

export default auth;
