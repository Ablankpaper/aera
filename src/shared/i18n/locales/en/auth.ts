const auth = {
  gate: {
    title: "Sign in to Aera",
    productCaption: "Your intelligent workspace",
    slogan: "Aila turns every idea into possibility.",
    checking: "Checking your Aera session…",
    browserNote:
      "Select sign in to finish in your browser. You will return to the desktop app automatically.",
    openBrowser: "Sign in / Register",
    waitingForBrowser: "Opening the sign-in page…",
    loggingIn: "Signing in…",
    browserNotOpened: "Browser did not open automatically?",
    copyLoginHint: "Copy the sign-in link and open it manually in your browser",
    copyLoginLink: "Copy sign-in link",
    copyingLoginLink: "Copying…",
    copiedLoginLink: "Sign-in link copied",
    restartLogin: "Restart sign-in",
    copyFailed: "The sign-in link could not be copied. Please try again.",
    restartFailed: "Sign-in could not restart. Select sign in again.",
    cancel: "Cancel",
    retry: "Retry",
    retrying: "Checking again…",
    loginFailed: "Browser sign-in did not finish. Please try again.",
    retryFailed: "Aera could not verify your session. Please try again.",
    cancelled: "Sign-in was cancelled.",
    legalPrefix: "By continuing, you agree to the",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    secureStorageTitle: "Secure storage is unavailable",
    secureStorageDescription:
      "Aera cannot safely store this device session. Enable your system keychain or credential service, then retry. Plaintext storage is never used.",
    reasons: {
      sign_in_required:
        "Sign in or create an account before using Aera.",
      offline_expired:
        "Your seven-day offline access has expired. Connect to the internet and sign in again.",
      clock_rollback:
        "The system clock changed unexpectedly. Connect to the internet to verify this device.",
      device_revoked:
        "This device's sign-in has expired. Sign in again to continue.",
      account_disabled:
        "This Aera account is currently disabled. Use the browser account page for help.",
      account_pending_deletion:
        "This account is pending deletion and cannot sign in to Aera.",
      secure_storage_unavailable:
        "Secure system storage is required for Aera sessions.",
    },
  },
  profile: {
    checkingTitle: "Checking local data access",
    checkingDescription:
      "Aera is checking ownership metadata without opening your private Runtime content.",
    title: "Choose how to use your local data",
    existingDescription:
      "Existing Aera Runtime data was found on this device. Choose whether to bind it in place or start with a separate empty space.",
    noUpload:
      "Neither choice uploads, copies, merges, or rewrites your Memory, sessions, files, skills, USER data, or learning state.",
    useExisting: "Use existing local data",
    createNew: "Create a new space",
    binding: "Binding securely…",
    creating: "Creating an empty space…",
    emptyBindingTitle: "Preparing your private work area",
    emptyBindingDescription:
      "The local Agent runtime is being prepared automatically.",
    connectionBindingTitle: "Securing this Runtime connection",
    connectionBindingDescription:
      "The remote or SSH connection is being bound to the signed-in Aera owner. Product tokens are not sent to the Runtime.",
    otherOwnerTitle: "This local data belongs to another account",
    otherOwnerDescription:
      "Aera will not open or reassign local Agent data owned by another account. Create a separate empty space or sign in with its owner.",
    remoteOtherOwnerTitle: "This Runtime connection belongs to another account",
    remoteOtherOwnerDescription:
      "Aera will not inherit the previous owner's remote or SSH connection context.",
    differentAccount: "Sign in with a different account",
    failedTitle: "Local access could not be prepared",
    failedDescription:
      "No private Runtime data was changed. Retry the ownership check when you are ready.",
    retry: "Retry ownership check",
  },
  offline: {
    title: "Local offline mode",
    description:
      "Cloud account features are paused. Local Agent work, model APIs, and Aera Runtime learning remain available until the signed offline deadline.",
  },
  account: {
    settingsNav: "Aera account",
    title: "Aera account",
    defaultDisplayName: "User",
    openMenu: "Open Aera account menu",
    signIn: "Sign in",
    signingIn: "Opening browser…",
    guestLocal: "Guest mode · local only",
    online: "Online · verified",
    offline: "Offline · local access",
    manage: "Manage account",
    devices: "Manage devices",
    recharge: "Recharge model API",
    switch: "Switch account",
    signOut: "Sign out",
    actionFailed: "This account action could not be completed.",
    unavailable: "Aera account information is unavailable.",
    userId: "Account ID",
    deviceId: "Device",
    offlineUntil: "Signed offline access is valid until {{date}}.",
    localDataWarning:
      "Deleting or signing out of the cloud account does not delete, move, upload, or unbind local Agent data, Memory, sessions, files, skills, or learning state.",
    rechargeSeparateAccount:
      "Recharge opens the independent model API website. Its accounts, balances, API keys, cookies, and tokens are separate from this Aera account.",
    pendingRevocationWarning:
      "If you sign out while the control plane is unreachable, this device may still count toward the five-device limit until the signed self-revocation is delivered automatically.",
    profile: {
      title: "Personal details",
      description:
        "Choose the name and personal details shown in Aera.",
      loading: "Loading details…",
      displayName: "Username",
      displayNamePlaceholder: "For example: Aera user",
      occupation: "Role / occupation",
      occupationPlaceholder: "For example: Independent developer",
      bio: "About you",
      bioPlaceholder: "Write a short introduction",
      uploadAvatar: "Change avatar",
      processingAvatar: "Processing…",
      removeAvatar: "Remove avatar",
      avatarHint: "JPG, PNG, or WebP. Images are cropped to a square.",
      localOnly:
        "Stored only on this device and kept separate for each signed-in account.",
      save: "Save details",
      saving: "Saving…",
      saved: "Details saved",
      nameRequired: "Enter a username.",
      uploadFailed: "This image could not be read. Try another one.",
      saveFailed: "The details could not be saved. Try again.",
    },
  },
};

export default auth;
