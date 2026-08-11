export default {
  title: "Agents",
  subtitle:
    "Create, publish, and use Agents while private data and learning stay local",
  legacyTitle: "On-device Agents",
  legacySubtitle:
    "Aera automatically prepares and isolates each Agent; no runtime management is required.",
  legacyAccountSyncLabel: "legacy account sync",
  legacyNewProfile: "New on-device Agent",
  newAgent: "New Agent",
  namePlaceholder: "Agent name (e.g. coder)",
  createTitle: "Create Agent",
  nameLabel: "Agent name",
  cloneConfig: "Clone config & API keys",
  cloneFromLabel: "Clone from",
  running: "Running",
  off: "Off",
  starting: "Starting…",
  createFailed: "Failed to create Agent",
  creating: "Creating...",
  create: "Create",
  deleteFailed: "Failed to delete Agent",
  active: "Active",
  noModel: "No model set",
  skillsCount: "{{count}} skills",
  gatewayRunning: "Gateway running",
  gatewayOff: "Gateway off",
  colProfile: "Agent",
  colModel: "Model",
  colStatus: "Status",
  colActions: "Actions",
  chat: "Chat",
  deleteConfirm: "Delete?",
  yes: "Yes",
  no: "No",
  deleteTitle: "Delete agent",
  auto: "Auto",
  local: "Local",
  manageProfiles: "Manage Agents",
  switchProfile: "Switch Agent",
  defaultTag: "default",
  editAppearance: "Edit Agent",
  editAppearanceFor: "Edit {{name}}",
  color: "Color",
  dangerZone: "Danger zone",
  deleteProfile: "Delete Agent",
  deleteProfileInfo:
    "Deleting this Agent permanently removes its config, memory, chat sessions, skills, and API keys. This can't be undone.",
  deleteProfileConfirm: "Delete this Agent permanently? This can't be undone.",
  edit: "Edit",
  uploadImage: "Upload image",
  removeImage: "Remove image",
  uploadImageFailed: "Couldn't set the Agent image",
  appearanceFailed: "Couldn't update the Agent appearance",
  sectionProfile: "Agent",
  sectionPersona: "Persona",
  sectionAgentMemory: "Agent Memory",
  sectionWallet: "Wallet",
  sectionSync: "Sync",
  sectionAdvanced: "Advanced",
  defaultNotDeletable: "The default Agent can't be deleted.",
  comingSoon: "Coming soon",
  walletTitle: "Base wallets",
  walletNetwork: "Network: {{network}}",
  walletCreate: "Create wallet",
  walletCreateTitle: "Create wallet",
  walletCreateNew: "New wallet",
  walletImportExisting: "Import wallet",
  walletName: "Wallet name",
  walletNamePlaceholder: "Main wallet",
  walletRecoveryPhrase: "Recovery phrase",
  walletRecoveryPlaceholder: "twelve words separated by spaces",
  walletSave: "Save wallet",
  walletCreating: "Saving...",
  walletEmpty: "No wallets yet",
  walletCopyAddress: "Copy address",
  walletCopied: "Copied",
  walletDeleteFailed: "Couldn't remove wallet",
  walletLoadFailed: "Couldn't load wallets",
  walletCreateFailed: "Couldn't add wallet",
  walletRecoveryTitle: "Recovery phrase",
  walletRecoveryInfo:
    "Save this phrase now. Aera will not show it again after this modal closes.",
  walletCopyRecovery: "Copy phrase",
  walletDone: "I've saved it",
  walletBalanceLoading: "Loading…",
  walletBalanceUnavailable: "Unavailable",
  walletBalanceRefresh: "Refresh",
  walletDeleteTitle: "Remove wallet",
  walletDeleteWarning:
    "This will permanently remove this wallet from Aera. Make sure you have backed up the recovery phrase — you won't be able to recover the wallet without it.",
  walletDeleteConfirmLabel: "Remove wallet",
  hub: {
    officialTab: "Official Agents",
    mineTab: "My Agents",
    enterpriseTab: "Enterprise Agents",
    searchPlaceholder: "Search Agents by name or capability",
    filters: "Filter Agents",
    officialTitle: "Official Agents",
    officialSubtitle:
      "Reviewed and published by Aera, then installed into an isolated local space.",
    mineSubtitle:
      "Create and manage your Agents. Open a card to review its abilities and start a conversation.",
    workspaceSubtitle:
      "Browse Agents in this team or project, or manage the ones your role can maintain.",
    organizationSubtitle:
      "Browse enterprise Agents and create, review, or install them when your role allows it.",
    officialFilter: {
      all: "All",
      installed: "Installed",
      updates: "Updates",
    },
    mineFilter: {
      all: "All",
      ready: "Ready",
      drafts: "Drafts",
    },
    offlineTitle: "You are offline",
    officialUnavailable:
      "Your current role cannot browse or install official Agents.",
    noSearchResults: "No matching Agents found",
    noSearchResultsHint: "Try another keyword or clear the search.",
    noFilteredResults: "No Agents match this filter",
    noFilteredResultsHint:
      "Choose another filter to see the rest of your Agents.",
    noPersonalAgents: "You have not created any Agents yet",
    noPersonalAgentsHint:
      "Create an Agent of your own and give it a job tailored to you.",
    noEnterpriseAgents: "No Enterprise Agents have been published",
    noEnterpriseAgentsHint:
      "Agents approved and published by enterprise administrators appear here for members to use.",
    createAgent: "Create Agent",
    officialEmptyHint: "Official Agents will appear here when published.",
    officialOfflineHint:
      "Reconnect to browse the catalog. Enabled Agents remain available locally.",
    officialPublisher: "Aera Official",
    officialCardDescription:
      "{{name}} has been reviewed by Aera and is ready to use.",
    officialDetailFallback:
      "{{name}} is an official Aera Agent that runs independently on this device to help complete tasks.",
    personalCardFallback:
      "This Agent is ready to help with work tailored to your instructions.",
    publishedCardDescription:
      "Published and ready to use. Aera completes setup automatically.",
    modelCompatibilityPendingCardDescription:
      "The current model is incompatible with this signed version. Configure a compatible model or publish a compatible version before retrying.",
    installedCardDescription:
      "Ready to use. Open the details to start a conversation.",
    pendingCardDescription:
      "This Agent is not ready yet. Continue setup from the details.",
    localProfileDescription:
      "Uses {{model}} with {{count}} configured Skills and is ready for conversation.",
    localProfileNoModel:
      "This local Agent does not have a model configured yet.",
    modelRequired:
      "This account has no usable model configuration. Configure one in Models first.",
    configureModelFirst: "Configure a model first",
    chooseRuntimeModel: "Choose a model for this use",
    chooseRuntimeModelHint:
      "Only your current account's model and credential are used. They are never written into the shared Agent.",
    runtimeModelChoice: "Runtime model for this use",
    legacyInstalledModelSource:
      "This route comes from an existing installed Agent Profile and remains available to this account.",
    confirmRuntimeModel: "Confirm and start",
    personalAgent: "My Agent",
    workspaceAgent: "Team / project Agent",
    organizationAgent: "Enterprise Agent",
    localAgent: "Local Agent",
    published: "Published",
    installed: "Enabled",
    pending: "Needs attention",
    localDraft: "Local draft",
    ready: "Ready",
    readyToInstall: "Ready to use",
    running: "Running",
    updateAvailable: "Update available",
    skillTag: "{{count}} Skills",
    sopTag: "{{count}} SOPs",
    knowledgeTag: "{{count}} knowledge items",
    toolTag: "{{count}} tools",
    localMemoryTag: "Memory stays local",
    isolatedProfileTag: "Private on this device",
    capabilityTitle: "Capabilities",
    expertiseTitle: "Areas of expertise",
    examplesTitle: "Try asking",
    exampleIntroduce: "Show me what {{name}} can do",
    examplePlan: "Turn my goal into an actionable plan",
    exampleExecute: "Help me complete this task from the first step",
    installAgent: "Start using",
    useAgent: "Start using",
    editAppearance: "Edit appearance",
    localProfileUnavailable: "This Agent is not ready on this device",
    advancedTitle: "Agent governance",
    advancedSubtitle:
      "Experience promotion, enterprise review, and access governance",
  },
  capabilityBinding: {
    title: "Configure local capabilities",
    requiredState:
      "This Agent needs a local MCP capability mapping before it can be used.",
    configure: "Configure capabilities",
    privateBoundary:
      "Choose compatible MCP servers from this device. Connection details and credentials stay in your local Profile.",
    required: "Required",
    optional: "Optional",
    localMcp: "Compatible local MCP",
    chooseRequired: "Choose a compatible MCP",
    skipOptional: "Skip this optional capability",
    noCompatibleServer: "No compatible enabled MCP is available.",
    onlineRequired: "Reconnect to save the mapping and finish setup.",
    save: "Save capability mapping",
  },
  sync: "Sync",
  syncing: "Syncing…",
  syncSignedOut: "Not synced",
  syncSignedOutHint:
    "Sign in to your Aera account on the Providers page to back agents up to the cloud.",
  syncUpToDate: "Synced with your Aera account",
  syncSummary: "Synced — {{pushed}} pushed, {{pulled}} pulled, {{created}} new",
  syncErrors: "Sync finished with {{count}} error(s)",
  syncUnauthorized: "Session expired — sign in again on the Providers page",
  syncFailed: "Sync failed",
  syncTitle: "Cloud sync",
  syncPaneSubtitle:
    "Back this agent up to your Aera account and pull changes made in the console.",
  syncNow: "Sync now",
  syncAccount: "Account",
  syncLink: "Cloud agent",
  syncLinked: "Linked",
  syncNotLinked: "Not linked yet — sync to create it",
  syncLastResult: "Last sync",
  syncSignInHint:
    "Sign in to your Aera account on the Providers page to sync this agent.",
  syncAction: {
    "up-to-date": "Up to date",
    pushed: "Pushed to cloud",
    pulled: "Pulled from cloud",
    "created-remote": "Backed up to cloud",
    "created-local": "Created from cloud",
    unlinked: "Unlinked (cloud agent was deleted)",
    error: "Sync error",
  },
  walletSync: "Refresh",
  walletSyncing: "Syncing…",
  walletSourceLocal: "Local",
  walletSourceCloud: "Cloud",
  walletManagedEmpty: "No wallets yet",
  walletSyncedHint:
    "Wallets are managed in your Aera account and appear here once this agent syncs.",
  walletSignInHint:
    "Sign in to your Aera account on the Providers page to see this agent's wallets.",
  walletForeignHint:
    "This agent is linked to a different Aera account, so its wallets stay untouched here.",
  control: {
    personalSpace: "My",
    personalSpaceTitle: "My Agents",
    personalSpaceSubtitle:
      "Create, publish, and use your Agents. Private data never becomes ordinary cloud sync.",
    workspaceSpace: "Team / project",
    workspaceSpaceTitle: "Team / project Agents",
    workspaceAuthorSubtitle:
      "Create, publish, and use team/project Agents while Aera manages runtime isolation.",
    workspaceMemberSubtitle:
      "Use approved team/project Agents. Members cannot create drafts or publish versions.",
    role: {
      owner: "Owner",
      admin: "Admin",
      auditor: "Auditor",
      member: "Member",
    },
    organization: {
      title: "Enterprise Agents",
      cachedReadOnly: "Cached enterprise data",
      newDraft: "New enterprise draft",
      prepareSubmission: "Prepare submission",
      submitForReview: "Submit for review",
      submissionPreviewTitle: "Review enterprise submission",
      submissionBoundary:
        "Submission starts a two-person review. It does not publish or install an Agent version.",
      reviewTitle: "Publication review",
      review: "Review",
      approve: "Approve version",
      reject: "Reject submission",
      confirmApproval: "Confirm approval",
      confirmRejection: "Confirm rejection",
      differentReviewerRequired:
        "A different Owner or Admin must review this submission.",
      submittedNotPublished:
        "Submitted for review. No Agent version was published or installed.",
      approvedNotInstalled:
        "Version approved. No employee private runtime data was changed.",
      rejectedNotPublished:
        "Submission rejected. No Agent version was published or installed.",
      runtimeBoundary:
        "Enterprise assets are read-only; your Agent still runs and learns locally.",
      immutableReviewPackage: "Review the exact immutable submitted package.",
      policyAndDlpPassed:
        "The submission passed the Organization policy and privacy checks required to reach review.",
      status: "Status",
      statusValue: {
        pending: "Pending review",
        approved: "Approved",
        rejected: "Rejected",
        withdrawn: "Withdrawn",
        superseded: "Superseded",
      },
      lifecycle: {
        localOnly: "Local draft",
        pending: "Pending review",
        rejected: "Review rejected",
        withdrawn: "Withdrawn",
        superseded: "Superseded",
        approvedCurrent: "Published",
        approvedDirty: "Published with unpublished changes",
      },
      contentDigest: "Content digest",
      baseVersion: "Base version",
      initialVersion: "Initial version",
      author: "Submitted by",
      reviewedBy: "Reviewed by",
      policyVersion: "Policy version",
      noSubmissions: "No enterprise submissions yet.",
      withdraw: "Withdraw submission",
      confirmWithdrawal: "Confirm withdrawal",
      withdrawalBoundary:
        "Withdrawal only closes this pending submission. Local drafts and Aera Runtime data stay unchanged.",
      deleteDraft: "Delete draft",
      deleteDraftTitle: "Delete local draft",
      deleteDraftBoundary:
        "Only the current account's local working copy is deleted. Enterprise submissions, published versions, installations, Memory, and Profiles remain unchanged.",
      confirmDeleteDraft: "Delete draft",
      discardUnpublished: "Discard unpublished changes",
      discardUnpublishedTitle: "Discard unpublished changes",
      discardUnpublishedBoundary:
        "The current local working copy is removed. The published enterprise Agent, installation, Memory, and Profile remain unchanged.",
      confirmDiscardUnpublished: "Discard changes",
      draftReadOnly:
        "This enterprise draft is read-only. Reconnect with an Owner or Admin role before changing or submitting it.",
    },
    official: {
      title: "Official Agents",
      badge: "Official",
      internalChannel: "Internal channel",
      stableChannel: "Stable channel",
      version: "Version",
      install: "Start using official Agent",
      confirmInstall: "Start using",
      installTitle: "Start using official Agent",
      freshProfileBoundary:
        "Aera prepares this Agent automatically. It will be ready to use when setup finishes.",
      privateDataBoundary:
        "Memory, conversations, files, credentials, private Skills, and local learning stay on this computer and are never uploaded by this flow.",
      installedLocally: "Verified official Agent installed locally",
      updateReady: "A managed update is ready",
      applyUpdate: "Apply for new conversations",
      applyingUpdate: "Applying update…",
      existingConversationsUnchanged:
        "Existing conversations stay unchanged; only new conversations use the updated release.",
      offlineLocalVersion: "Verified local official version",
      offlineMayBeStale:
        "Offline catalog status may be stale. The installed local Agent remains available.",
      noAgents: "No official Agents are available for this device.",
      noInstalledOffline: "No verified official Agents are installed locally.",
      pausedForNewInstalls:
        "This official release is paused for new installations.",
      installedSource: "Installed official Agent",
      refresh: "Refresh official Agents",
    },
    refresh: "Refresh Agent control plane",
    newAgent: "New Agent",
    offlineNotice:
      "Offline access is active. Local drafts and installed Agents remain available; publication, discovery, installation, and reconciliation are paused.",
    workspaceOfflineNotice:
      "Team/project access is offline. Verified installations remain usable locally; drafts are read-only and cloud publication, discovery, installation, and updates are paused.",
    localDrafts: "Local drafts",
    noDrafts: "No local drafts yet.",
    revision: "Revision",
    published: "Published",
    localOnly: "Local only",
    edit: "Edit",
    view: "View",
    publishedAgents: "Published Agents",
    noPublishedAgents: "No published Agents yet.",
    discoveryPaused: "Cloud discovery is paused while offline.",
    immutableVersion: "Immutable signed version",
    install: "Install",
    installations: "Installations on this device",
    noInstallations: "No Agent installations on this device.",
    pendingInstallation: "Pending materialization — safe to retry",
    installedLocally: "Installed locally",
    retry: "Retry",
    update: "Select version",
    archive: "Archive",
    close: "Close",
    cancel: "Cancel",
    newDraftTitle: "Create Agent",
    editDraftTitle: "Edit Agent",
    localDraftStatus:
      "Define the Agent's identity and capabilities, then save a draft or publish it.",
    workspaceDraftReadOnly:
      "This team/project draft is read-only while offline. Reconnect before changing or publishing it.",
    name: "Agent name",
    systemPrompt: "Identity and working style",
    allowedProviders: "Runtime service",
    allowedModels: "Runtime model",
    runtimeModel: "Runtime model",
    runtimeModelHint:
      "Only currently available model routes are shown, with the provider after the model name.",
    runtimeModelUnavailable: "No live model route is currently available",
    runtimeModelChosenOnUse:
      "The model is optional. Each user chooses from their own available models when starting the Agent.",
    modelPolicyMode: "Model behavior",
    modelPolicyHint:
      "Choose at use time by default. Pin or restrict a model only when the Agent truly requires it.",
    modelPolicy: {
      userSelect: "Choose when starting (recommended)",
      fixed: "Pin one model",
      allowlist: "Restrict to allowed models",
    },
    runtimeModelRequired:
      "This account does not have a configured model for running Agents yet. You can publish now and start using it after configuring a model.",
    identityUpload: "Import Markdown identity",
    identityUploadHint:
      "Upload an existing Markdown prompt or identity document.",
    fileImported: "Imported {{name}}",
    versionAssets: "Capability documents",
    versionAssetsHint:
      "Choose Skill, SOP, or knowledge documents; Aera creates their internal structure.",
    assetUpload: "Add {{kind}} document",
    noVersionAssets: "No capability documents yet.",
    uploadTooLarge: "Each document must be 256 KB or smaller.",
    uploadEmpty: "The selected document is empty.",
    uploadFailed: "The selected document could not be read.",
    assetKind: "Asset category",
    assetPath: "Asset path",
    assetContent: "Asset content",
    removeAsset: "Remove asset",
    asset: {
      skill: "Skill",
      sop: "SOP",
      knowledge: "Knowledge",
    },
    capabilities: {
      title: "Installed capabilities",
      hint: "Choose an installed Skill or MCP capability. Aera copies Skill content, but only publishes logical MCP requirements.",
      chooseInstalled: "Choose installed Skill / MCP",
      selectedCapabilities: "Selected capabilities",
      profile: "Source Profile",
      installedSkill: "Installed Skill",
      chooseSkill: "Choose a Skill",
      previewSkill: "Preview Skill snapshot",
      addSkill: "Add Skill snapshot",
      replaceSkill: "Replace Skill snapshot",
      mcpServer: "Configured MCP",
      chooseMcp: "Choose an MCP",
      mcpTools: "Allowed MCP tools",
      required: "Required capability",
      permissionReason: "Permission reason",
      previewMcp: "Preview MCP requirement",
      addMcp: "Add MCP requirement",
      removeMcp: "Remove MCP requirement",
      duplicateMcp: "This logical MCP requirement is already selected.",
    },
    savedLocally: "Draft saved.",
    saveLocal: "Save draft",
    publish: "Publish",
    publishAndUse: "Publish and use",
    publishAndUseSequence:
      "Publish and use publishes first, then lets the current user choose their own model before opening a conversation.",
    publishPreviewTitle: "Review publication",
    target: "Target",
    totalBytes: "Total bytes",
    privateDataExcluded:
      "Excluded: Memory, USER, sessions, files, credentials, API keys, and unpromoted local learning.",
    confirmPublish: "Confirm publication",
    publishOnlySuccess: "Agent published.",
    agentReadyManualOpen:
      "The Agent is ready. Open it from My Agents to start using it.",
    retryAgent: "Continue setup",
    installTitle: "Start using Agent version",
    retryTitle: "Continue Agent setup",
    updateTitle: "Select a version for later conversations",
    installIsolationHint:
      "Aera prepares this Agent automatically and keeps its private data isolated.",
    freshProfile: "Create a new Agent",
    claimProfile: "Use an existing Agent",
    profileName: "Agent name",
    noCloneHint: "Aera never copies another Agent's private data.",
    localProfile: "On-device Agent",
    claimConfirmation:
      "I understand this reuses the selected on-device Agent data without copying or rewriting it.",
    version: "Published version",
    selectVersion: "Use for new conversations",
    updateNewConversationsOnly:
      "Active conversations stay unchanged. New conversations use the selected version.",
    archiveTitle: "Archive Agent",
    archiveKeepsLocalData:
      "Archiving stops cloud activation for this Agent. Local memory, sessions, files, and learned Skills stay on this computer.",
    confirmArchive: "Confirm archive",
    experience: {
      promoteLocalExperience: "Promote local experience",
      promotionTitle: "Promote local experience",
      promotionSubtitle:
        "Select one learned Skill, inspect the local privacy scan, then explicitly submit it for team/project review.",
      privateBoundary:
        "Only the selected Skill files are prepared. Identity, memory, conversations, sessions, credentials, and every unselected local learning result stay on this computer.",
      skill: "Learned Skill",
      chooseSkill: "Choose one eligible Skill",
      preparePreview: "Prepare local preview",
      previewTitle: "Promotion preview",
      sourceAgent: "Source Agent",
      sourceVersion: "Source version",
      fileCount: "Files",
      digest: "Content digest",
      dlpPassed: "Local privacy scan passed.",
      dlpBlocked:
        "Submission is blocked until these local privacy findings are resolved.",
      dlp: {
        credential_private_key: "Private key material",
        credential_bearer_token: "Bearer token",
        credential_jwt: "JSON Web Token",
        credential_url: "Credential-bearing URL",
        credential_api_key: "API key",
        credential_environment_secret: "Environment secret",
        private_absolute_path: "Private absolute path",
        private_memory_payload: "Aera Runtime Memory payload",
        private_user_payload: "Aera Runtime USER payload",
        private_session_payload: "Session payload",
        private_conversation_payload: "Conversation payload",
        private_credential_store_payload: "Credential-store payload",
        private_curator_payload: "Curator payload",
      },
      onlineToSubmit:
        "This preview is safely stored locally. Reconnect before submitting it for review.",
      submitConfirmation:
        "I explicitly choose this Skill for team/project review and understand that submission does not publish an Agent version.",
      submitForReview: "Submit for review",
      retryUpload: "Retry upload manually",
      myCandidates: "My candidates",
      noCandidates: "No promoted experience candidates yet.",
      reviewQueue: "Experience review",
      noReviewItems: "No candidates are waiting for review.",
      review: "Review",
      createDraftRetry: "Create draft",
      status: {
        PREPARED: "Prepared locally",
        UPLOAD_FAILED: "Upload failed — local result preserved",
        SUBMITTED: "Submitted",
        PENDING_REVIEW: "Waiting for review",
        APPROVED: "Approved",
        REJECTED: "Rejected",
      },
      reviewTitle: "Review promoted experience",
      reviewBoundary:
        "Review this selected Skill only. Approval does not publish a version or modify on-device Agent data.",
      onlineToReview: "Reconnect to review or import experience candidates.",
      approve: "Approve",
      reject: "Reject",
      rejectionReason: "Rejection reason",
      chooseReason: "Choose a reason",
      reason: {
        not_reusable: "Not reusable across the team / project",
        insufficient_quality: "Needs more quality work",
        wrong_scope: "Belongs to a different Agent or scope",
        policy_blocked: "Blocked by team/project policy",
      },
      safeNote: "Optional safe note",
      commitReview: "Commit review",
      importTitle: "Create a draft from the approved Skill",
      replacementWarning:
        "The latest published version already contains this Skill name. Confirming creates a new draft that replaces only that Skill directory.",
      baseRefreshed:
        "The published base advanced. The diff was refreshed before any draft was written; review it again.",
      addedPaths: "Added files",
      replacedPaths: "Replaced files",
      removedPaths: "Removed files",
      importConfirmation:
        "Apply this approved Skill to the verified latest version as a new local draft.",
      createDraft: "Create draft",
    },
    organizationExperience: {
      contribute: "Contribute experience",
      contributionTitle: "Contribute Organization experience",
      privateBoundary:
        "Only the explicitly selected learned Skill is prepared. Memory, USER data, conversations, sessions, credentials, MCP configuration, Profile paths, and unrelated Skills stay on this computer.",
      skill: "Learned Skill",
      chooseSkill: "Choose one eligible Skill",
      preparePreview: "Prepare local preview",
      sourceAgent: "Source Organization Agent",
      sourceVersion: "Source version",
      dlpPassed: "Local privacy scan passed.",
      onlineToSubmit:
        "The immutable preview remains local. Reconnect to submit it for Organization review.",
      submitConfirmation:
        "I explicitly contribute this selected Skill and understand that approval does not publish an Agent version.",
      submitForReview: "Submit for Organization review",
      myCandidates: "My Organization experience",
      noCandidates: "No Organization experience candidates yet.",
      reviewQueue: "Organization experience governance",
      onlineToReview: "Reconnect to review or inspect Organization experience.",
      noReviewItems: "No Organization experience candidates are available.",
      retryUpload: "Retry upload",
      review: "Review",
      view: "View",
      reviewTitle: "Review Organization experience",
      reviewBoundary:
        "Review only this immutable Skill snapshot. Approval does not publish or modify the employee's source Profile.",
      approve: "Approve",
      reject: "Reject",
      rejectionReason: "Rejection reason",
      reason: {
        not_reusable: "Not reusable across the Organization",
        insufficient_quality: "Needs more quality work",
        wrong_scope: "Belongs to another Agent or Organization",
        policy_blocked: "Blocked by Organization policy",
      },
      safeNote: "Optional safe note",
      commitReview: "Commit review",
      replacementWarning:
        "The latest published version already contains this Skill. Confirming creates or reopens a local next-version draft and changes only this Skill directory.",
      importConfirmation:
        "Apply this approved Skill to the verified latest Organization version as a local next-version draft.",
      createDraft: "Create Organization draft",
    },
    errors: {
      invalid_request: "The Agent request is invalid.",
      sign_in_required: "Sign in to Aera to continue.",
      online_required: "A live Aera Cloud connection is required.",
      entitlement_required: "Your Aera access authorization must be renewed.",
      not_found: "The Agent item no longer exists.",
      conflict: "This draft or installation changed. Refresh before retrying.",
      verification_failed: "The Agent version could not be verified.",
      signature_verification_failed:
        "The Agent signature remained invalid after refreshing verification keys, so publication did not complete.",
      published_content_mismatch:
        "The Agent version content or digest returned by Cloud did not match this draft, so publication closed safely.",
      publication_cache_failed:
        "The Agent version was verified but could not be cached safely on this device, so publication did not complete.",
      publication_cache_conflict:
        "Conflicting local cache state was found for this Agent version, so Aera stopped using it. Retry; if it persists, restart Aera and try again.",
      publication_cache_corrupt:
        "The local Agent version cache failed its integrity check and was not used. Retry so Aera can attempt a safe recovery.",
      publication_cache_permissions_invalid:
        "The local Agent version cache is no longer read-only and was rejected. Retry so Aera can attempt a safe recovery.",
      publication_cache_filesystem_denied:
        "The operating system denied the Agent version cache operation. Confirm that disk space is available, then retry.",
      publication_cache_filesystem_failed:
        "The local filesystem could not complete the Agent version cache operation. Confirm that disk space is available, then retry.",
      publication_cache_database_failed:
        "The local cache index could not be committed. The verified version was retained for automatic recovery; retry or restart Aera.",
      publication_cache_recovery_failed:
        "The local Agent version cache could not complete automatic recovery, so publication stopped safely. Retry or restart Aera.",
      runtime_incompatible:
        "This Agent version is not compatible with this device's local environment.",
      profile_model_configuration_failed:
        "The current model is incompatible with this signed Agent version. Configure a model allowed by the version, or ask the publisher to release a version compatible with the current model.",
      model_route_stale:
        "The selected model changed while this Agent was being prepared. Refresh the model list and select it again.",
      model_route_unavailable:
        "The selected model is no longer available for this account. Refresh the model list and choose another configured route.",
      capability_profile_unavailable:
        "The selected local Profile is unavailable. Refresh and try again.",
      capability_source_unsafe:
        "The selected capability contains local content that cannot be copied safely.",
      capability_dlp_blocked: "The local privacy scan blocked this capability.",
      capability_handle_invalid:
        "The capability preview is no longer valid. Select it again.",
      capability_handle_expired:
        "The capability preview expired. Select it again.",
      capability_requirement_invalid:
        "The selected MCP capability or tool changed. Refresh and try again.",
      local_runtime_required:
        "The local Agent service is not ready yet. Try again shortly; setup is automatic.",
      cloud_unavailable: "Aera Cloud is temporarily unavailable.",
      workspace_forbidden:
        "Your current team/project role does not allow this Agent operation.",
      workspace_archived:
        "This team or project is archived. Its Agent assets are read-only.",
      workspace_owner_unavailable:
        "This team or project is read-only until its Owner account is available.",
      organization_agent_not_found:
        "This enterprise Agent item no longer exists.",
      organization_agent_forbidden:
        "Your current Organization role does not allow this Agent operation.",
      organization_archived:
        "This Organization is archived. Its Agent assets are read-only.",
      organization_submission_conflict:
        "This enterprise submission changed. Refresh before retrying.",
      organization_submission_superseded:
        "A newer enterprise submission replaced this one.",
      organization_publication_policy_blocked:
        "Organization policy blocked this Agent submission.",
      organization_publication_dlp_blocked:
        "The enterprise privacy scan blocked this Agent submission.",
      official_agent_not_eligible:
        "This official Agent is not available for the current account and device.",
      official_release_paused:
        "This official release is paused for new installations.",
      official_client_version_unsupported:
        "Update Aera before installing this official Agent.",
      official_installation_policy_blocked:
        "Platform policy does not allow this official Agent installation.",
      candidate_source_ineligible:
        "This installation or Skill is not eligible for promotion.",
      candidate_dlp_blocked: "The local privacy scan blocked this candidate.",
      candidate_already_reviewed:
        "This candidate already has a final review decision.",
      candidate_not_approved: "Only an approved candidate can create a draft.",
      candidate_base_advanced:
        "The published Agent advanced. Refresh the import preview.",
      candidate_import_failed:
        "The approved Skill could not be written into a local draft. The approval and local Aera Runtime learning remain unchanged.",
      operation_failed: "The Agent operation could not be completed safely.",
    },
  },
} as const;
