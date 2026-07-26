export default {
  title: "Current Agent Memory",
  subtitle:
    "Private memory for Agent {{agent}}. It is not automatically shared with other Agents.",
  sessions: "Sessions",
  messages: "Messages",
  memories: "Memories",
  providersTitle: "Providers",
  agentMemory: "Agent Long-term Memory",
  userProfile: "What This Agent Knows About You",
  globalProfileTab: "Global Behavior Profile",
  globalProfileTitle: "Account-wide Global User Behavior Profile",
  globalProfileHint:
    "Store only stable behavior preferences that apply across Agents. Every Agent receives them read-only; Agent names, one-off tasks, and private memories do not belong here.",
  globalProfileCategory: "Behavior category",
  globalProfileKey: "Profile key",
  globalProfileKeyPlaceholder: "e.g. preferred_address",
  globalProfileContent: "Stable behavior preference",
  globalProfileContentPlaceholder:
    "Describe a communication, decision, risk, work, or tool preference that applies to every Agent.",
  globalProfileExplicitOnly:
    "Adding is an explicit user confirmation. Ordinary chat never writes directly to the global profile.",
  globalProfileAdd: "Confirm and Add",
  globalProfileEmpty: "No confirmed global behavior preferences yet.",
  globalProfileHistory: "Version History",
  globalProfileRollback: "Restore as New Version",
  removeGlobalProfileEntry: "Remove global profile entry",
  globalCategories: {
    communication_style: "Communication Style",
    decision_pattern: "Decision Pattern",
    risk_preference: "Risk Preference",
    work_habit: "Work Habit",
    tool_preference: "Tool Preference",
    accessibility: "Accessibility",
    locale: "Language and Locale",
  },
  privateToCurrentAgent: "Readable and writable only by this Agent",
  entries: "{{count}} entries",
  addMemory: "Add Memory",
  loadFailed: "Failed to load memory",
  addFailed: "Failed to add entry",
  updateFailed: "Failed to update entry",
  saveFailed: "Failed to save",
  entriesPlaceholder: "e.g. This project uses TypeScript in strict mode.",
  userProfilePlaceholder:
    "e.g. The user prefers concise answers from this Agent. This stays private to the current Agent.",
  noProvidersFound: "No memory providers found in this installation.",
  openProviderWebsite: "Open provider website",
  noMemoriesYet:
    "No memories yet. AgentEra will save important facts as you chat.",
  noMemoryEntries: "No memory entries yet.",
  noToolsetsFound: "No toolsets found.",
  addManuallyHint: "You can also add memories manually using the button above.",
  userProfileHint:
    "This is the current Agent's private USER.md. It is not your account-wide global behavior profile.",
  providersHint:
    "Pluggable memory providers give AgentEra advanced long-term memory. Built-in memory (above) is always active alongside the selected provider.",
  providersHintActive: "Active: <strong>{{provider}}</strong>",
  providersHintInactive: "No external provider active — using built-in only.",
  enterEnvKey: "Enter {{key}}",
  chars: "{{count}} chars",
  capacity: "{{used}} / {{limit}} chars ({{percent}}%)",
  cancel: "Cancel",
  save: "Save",
  edit: "Edit",
  deleteConfirm: "Delete?",
  yes: "Yes",
  no: "No",
  saveProfile: "Save Profile",
  repairTitle: "Safely Repair Misplaced Agent Identity",
  repairHint:
    "If this Agent wrote its own name or identity into USER.md, preview the file and manually remove only that content.",
  reviewRepair: "Preview Repair",
  repairWarning:
    "Nothing is classified or migrated automatically. Remove only text you confirm belongs to the Agent's own identity. A reversible backup is created before applying.",
  repairOriginal: "Before (read-only)",
  repairReplacement: "After preview",
  repairConfirm:
    "I reviewed this change and confirm applying it to the current Agent's USER.md.",
  applyRepair: "Back Up and Apply",
  repairApplied: "Repair applied. The original file was backed up safely.",
  undoRepair: "Undo This Repair",
  repairFailed: "Could not prepare or apply the USER.md repair",
  undoRepairFailed: "Could not safely undo this repair",
  active: "Active",
  deactivate: "Deactivate",
  activating: "Activating...",
  activate: "Activate",
  providers: {
    honcho:
      "AI-native cross-session user modeling with dialectic Q&A and semantic search",
    hindsight:
      "Long-term memory with knowledge graph and multi-strategy retrieval",
    mem0: "Server-side LLM fact extraction with semantic search and auto-deduplication",
    retaindb: "Cloud memory API with hybrid search and 7 memory types",
    supermemory:
      "Semantic long-term memory with profile recall and entity extraction",
    holographic:
      "Local SQLite fact store with FTS5 search and trust scoring (no API key needed)",
    openviking:
      "Session-managed memory with tiered retrieval and knowledge browsing",
    byterover: "Persistent knowledge tree with tiered retrieval via brv CLI",
  },
} as const;
