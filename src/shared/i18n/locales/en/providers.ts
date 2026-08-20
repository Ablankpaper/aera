export default {
  title: "Models",
  subtitle: "Connect model services and choose a default model",
  keySet: "Key saved",
  setupPrompt: {
    title: "No AI model is configured for this session",
    description:
      "Configure a model so Aila can understand and carry out your requests. Set one up now?",
    later: "Later",
    configure: "Configure",
  },
  center: {
    generalTab: "General models",
    auxiliaryTab: "Auxiliary models",
    advancedTab: "Advanced",
    generalTitle: "Models",
    generalSubtitle:
      "Choose a service, enter its API key, and let Aera fetch the models.",
    addModel: "Add model",
    defaultModel: "Default model",
    targetProfile: "Configuration profile: {{profile}}",
    notConfigured: "Not configured",
    changeDefault: "Change default",
    selectDefault: "Select default",
    configuredTitle: "Configured model services",
    configuredSubtitle:
      "Search, switch, refresh, edit, or delete model services here.",
    count: "{{count}} services",
    filteredCount: "{{count}} of {{total}} services",
    searchPlaceholder: "Search services, URLs, or models…",
    clearSearch: "Clear search",
    noSearchResults: "No matching model services",
    emptyTitle: "No model services yet",
    emptyHint:
      "Add your first service and Aera will connect and fetch its models.",
    addFirst: "Add your first model",
    inUse: "In use",
    modelsCount: "{{count}} models",
    ready: "Key saved · ready to fetch models",
    dialogTitle: "Add model service",
    editDialogTitle: "Edit model service",
    dialogSubtitle:
      "Preset mode fills the endpoint and protocol. You only need the API key.",
    providerType: "Service type",
    preset: "Preset",
    custom: "Custom",
    provider: "Model provider",
    chooseProvider: "Choose a model provider…",
    name: "Name",
    namePlaceholder: "Generated from the Base URL",
    baseUrl: "Base URL",
    baseUrlPlaceholder: "e.g. https://api.example.com/v1",
    autoFilled: "Filled automatically for this provider",
    apiKey: "API Key",
    apiKeyPlaceholder: "Enter the API key from your provider",
    connecting: "Fetching…",
    connected: "Fetched",
    connect: "Fetch",
    manualModelHint:
      "No model catalog was detected. Check the Base URL or enter the model ID below.",
    modelPlaceholder: "Select or enter a model ID",
    modelsFound: "{{count}} models found",
    savedModelsCount: "Saved locally: {{count}} models",
    fetchedModelsCount: "Fetched this time: {{count}} models",
    modelHint:
      "Connect to load available models. You can also enter an ID manually.",
    contextLength: "Context length",
    contextLengthValue: "{{model}} · {{count}} context",
    contextLengthPlaceholder: "e.g. 256000 (optional)",
    apiMode: "API mode",
    providerLabel: "Provider",
    modelList: "Models",
    currentDefault: "Current default",
    presetType: "Preset",
    customType: "Custom",
    defaultShort: "Default",
    chooseDefault: "Choose and set a default model",
    noModels: "No models",
    noModelsHint: "Use “Refresh models” to fetch this service's catalog.",
    setDefault: "Set as default",
    defaultUpdated: "Default model updated.",
    refreshModels: "Refresh models",
    refreshing: "Refreshing…",
    refreshSuccess: "{{count}} models fetched and saved.",
    refreshEmpty: "Connected, but the service returned no models.",
    deleteService: "Delete",
    deleteTitle: "Delete model service",
    deleteDescription:
      "This removes the service's model records, configuration, and saved key. This cannot be undone.",
    deleteActiveFallback:
      "This is the current default. Aera will switch to another available service before deleting it.",
    deleteLastActive:
      "This is the last available service. The default model will be cleared after deletion.",
    confirmDelete: "Delete service",
    addAndUse: "Add and use",
    saveAndUse: "Save and use",
    warnings: {
      refresh:
        "The model service was saved, but one screen refresh did not complete. The saved configuration is still active.",
    },
    actions: {
      retry: "Retry",
      restart: "Restart Aera",
      review: "Review settings",
      support: "Contact support",
    },
    errors: {
      selectProvider: "Choose a model provider first.",
      baseUrl: "Enter a valid Base URL.",
      apiKey: "Enter an API key.",
      connection:
        "Connection failed. Check the API key, network, and endpoint.",
      authentication: "The model service rejected this API key.",
      forbidden: "The model service denied access. Check account permissions.",
      notFound: "The model-list endpoint was not found. Check the Base URL.",
      rateLimited:
        "The model service is rate limiting requests. Try again later.",
      upstream:
        "The model service is temporarily unavailable. Try again later.",
      malformed: "The model service returned an invalid model catalogue.",
      timeout: "Fetching models timed out. Check the network and try again.",
      network:
        "Could not reach the model service. Check the network and Base URL.",
      name: "Enter a service name.",
      model: "Choose or enter a default model.",
      activate: "Could not switch the default model. Try again.",
      delete: "Could not delete the service. Its configuration was kept.",
      save: "Could not save the model service. Try again.",
      stage:
        "The model service was not saved. No partial configuration was kept.",
      runtimeNative:
        "The local model configuration component could not load. Reinstall this version and try again. Diagnostic",
      nativeModuleAbiMismatch:
        "A packaged model component does not match this Aera version. Reinstall Aera.",
      nativeModuleArchitectureMismatch:
        "A packaged model component is for a different computer architecture. Install the correct Aera build.",
      nativeModuleDependencyMissing:
        "A required packaged model component is missing. Reinstall Aera.",
      nativeModuleLoadDenied:
        "macOS or Windows blocked a packaged model component. Reinstall the signed Aera build.",
      nativeModuleLoadFailed:
        "A packaged model component could not load. Restart or reinstall Aera.",
      databaseUnavailable:
        "The local model configuration database is unavailable. Restart Aera.",
      schemaUnsupported:
        "This model configuration requires a newer Aera version.",
      routeCatalogRepairRequired:
        "The local model route catalogue has an ambiguous conflict and was left unchanged.",
      recoveryRequired:
        "Model configuration requires safe recovery before another save.",
      authRequired:
        "Sign in to your Aera account before saving model configuration.",
      staleCatalogRevision:
        "The model list changed while editing. Refresh and retry.",
      ownerTransitionInProgress:
        "Account switching is still in progress. Retry when it completes.",
      ownerChanged:
        "The signed-in account changed during this save. Review the active account and retry.",
      ownerTransitionTimeout:
        "The previous account did not close in time. Restart Aera before retrying.",
      ownerTransitionFailed:
        "The previous account could not close safely. Restart Aera before retrying.",
      refreshFailed:
        "The configuration was restored, but one screen could not refresh. Restart Aera.",
      unknownFailure:
        "Model configuration failed for an unrecognized reason. Use the diagnostic ID when contacting support.",
      database:
        "The local model configuration database is unavailable. Restart Aera and try again. Diagnostic",
      schema:
        "This model configuration requires a newer Aera version. Diagnostic",
      routeCatalog:
        "The local model route catalogue is inconsistent and could not be repaired safely. Diagnostic",
      recovery:
        "Model configuration is being recovered safely. Try again shortly. Diagnostic",
      validation:
        "Model configuration changed. Refresh the page and try again.",
      credential:
        "The API key was not saved. The previous configuration was kept.",
      provider:
        "The model service was not saved. The previous configuration was kept.",
      modelLibrary:
        "The model list was not saved. The previous configuration was kept.",
      route:
        "The model route was not saved. The previous configuration was kept.",
      activation: "The model was saved but could not be made the default.",
      verification:
        "The saved model configuration did not verify. The previous configuration was restored.",
      rollback:
        "Model configuration recovery did not finish, so Aera stopped further writes.",
      replacementRequired:
        "Choose another configured model before deleting the active service.",
    },
  },
  model: {
    select: "Select model",
    emptyHint: "No model selected yet. Choose a configured provider and model.",
    pickerTitle: "Select default model",
    noModels: "No providers configured yet. Add one below first.",
    noProviderModels: "No models found for this provider yet.",
    use: "Use model",
  },
  keys: {
    addProvider: "Add provider",
    emptyHint: "No providers configured yet. Add one to get started.",
    searchPlaceholder: "Search providers…",
    allConfigured: "All providers are already configured.",
    remove: "Remove provider",
    custom: {
      title: "Custom provider",
      pickerHint: "Any OpenAI-compatible base URL",
      namePlaceholder: "Name (e.g. ChatGPT Codex)",
      baseUrlPlaceholder: "Base URL (e.g. https://api.example.com/v1)",
      keyPlaceholder: "API key (optional)",
      baseUrlNeeded: "Enter a name and base URL to add models.",
    },
    status: {
      needsKey: "Add a key to connect",
      verifying: "Verifying key…",
      verified: "Connected · key verified",
      connected: "Connected",
      failed: "Couldn't verify key",
    },
  },
  models: {
    title: "Models",
    empty: "No models yet.",
    addPlaceholder: "Add another model ID…",
    displayName: "Display name",
    contextWindow: "Context window (tokens)",
    contextWindowPlaceholder: "Auto",
    contextWindowHint:
      "Shared across every provider serving this model. Leave blank to auto-detect.",
  },
  oauth: {
    sectionTitle: "Subscription / OAuth Plans",
    sectionHint:
      "Sign in with a provider subscription instead of an API key. Authorization happens in your browser.",
    signIn: "Sign in",
    runningHint: "Follow the steps below to finish signing in.",
    successHint: "Signed in successfully. You can now select this provider.",
    failed: "Sign-in failed.",
    codexDesc: "Use your ChatGPT Codex plan",
    xaiDesc: "Use your xAI Grok subscription",
    qwenDesc: "Use your Qwen subscription",
    geminiDesc: "Use your Google AI Pro / Gemini plan",
    minimaxDesc: "Use your MiniMax subscription",
    nousDesc: "Sign in with your Nous Portal subscription",
  },
  hermesAccount: {
    sectionTitle: "Hermes One account",
    sectionHint:
      "Sign in to your Hermes One account to sync agents, workspaces, and wallets across devices.",
    signIn: "Sign in to Hermes One",
    signOut: "Sign out",
    signedInAs: "Signed in as",
    connected: "Connected · agents sync automatically",
    modalTitle: "Sign in to Hermes One",
    codeHint: "Approve in your browser. Make sure it shows the same code:",
    waitingHint: "Waiting for approval…",
    signedIn: "Signed in",
    openBrowser: "Open browser again",
    copyCode: "Copy code",
    copied: "Copied",
    successHint: "You're signed in. You can close this window.",
    failed: "Sign-in failed.",
  },
} as const;
