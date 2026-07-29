import enAgents from "../en/agents";

export default {
  title: "Agenci",
  subtitle:
    "Każdy agent działa w odizolowanym środowisku Aera z własną konfiguracją, pamięcią i umiejętnościami",
  newAgent: "Nowy agent",
  namePlaceholder: "Nazwa agenta (np. coder)",
  createTitle: "Nowy agent",
  nameLabel: "Nazwa agenta",
  cloneConfig: "Sklonuj konfigurację i klucze API",
  cloneFromLabel: "Klonuj z",
  running: "Działa",
  off: "Wył.",
  starting: "Uruchamianie…",
  createFailed: "Nie udało się utworzyć agenta",
  creating: "Tworzenie...",
  create: "Utwórz",
  active: "Aktywny",
  noModel: "Nie ustawiono modelu",
  skillsCount: "{{count}} umiejętności",
  gatewayRunning: "Bramka działa",
  gatewayOff: "Bramka wyłączona",
  colProfile: "Agent",
  colModel: "Model",
  colStatus: "Status",
  colActions: "Akcje",
  chat: "Czat",
  deleteConfirm: "Usunąć?",
  yes: "Tak",
  no: "Nie",
  deleteTitle: "Usuń agenta",
  auto: "Auto",
  local: "Lokalny",
  sectionWallet: "Wallet",
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
  control: {
    experience: enAgents.control.experience,
    official: enAgents.control.official,
    workspaceSpace: "Obszar roboczy",
    workspaceSpaceTitle: "Agenci obszaru roboczego",
    workspaceAuthorSubtitle:
      "Twórz lokalne szkice i publikuj niezmienne wersje obszaru; środowisko lokalne jest przygotowywane automatycznie.",
    workspaceMemberSubtitle:
      "Używaj zatwierdzonych wersji z automatycznie przygotowanym środowiskiem lokalnym. Członkowie nie mogą tworzyć ani publikować szkiców.",
    role: {
      owner: "Właściciel",
      admin: "Administrator",
      auditor: "Audytor",
      member: "Członek",
    },
    organization: {
      title: "Agenci firmowi",
      cachedReadOnly: "Dane firmowe z pamięci podręcznej (tylko do odczytu)",
      newDraft: "Nowy szkic firmowy",
      prepareSubmission: "Przygotuj zgłoszenie",
      submitForReview: "Wyślij do przeglądu",
      submissionPreviewTitle: "Przejrzyj zgłoszenie firmowe",
      submissionBoundary:
        "Zgłoszenie rozpoczyna przegląd dwuosobowy; nie publikuje ani nie instaluje wersji.",
      reviewTitle: "Przegląd publikacji",
      review: "Przejrzyj",
      approve: "Zatwierdź wersję",
      reject: "Odrzuć zgłoszenie",
      confirmApproval: "Potwierdź zatwierdzenie",
      confirmRejection: "Potwierdź odrzucenie",
      differentReviewerRequired:
        "Inny Właściciel lub Administrator musi przejrzeć to zgłoszenie.",
      submittedNotPublished:
        "Wysłano do przeglądu. Żadna wersja nie została opublikowana ani zainstalowana.",
      approvedNotInstalled:
        "Wersja zatwierdzona. Nie zmieniono lokalnych danych wykonawczych ani Memory pracownika.",
      rejectedNotPublished:
        "Zgłoszenie odrzucone. Żadna wersja nie została opublikowana ani zainstalowana.",
      runtimeBoundary:
        "Zasoby firmowe są tylko do odczytu; Agent nadal działa i uczy się lokalnie.",
      immutableReviewPackage:
        "Przejrzyj dokładny, niezmienny przesłany pakiet.",
      policyAndDlpPassed:
        "Zgłoszenie przeszło wymagane firmowe kontrole zasad i prywatności.",
      status: "Stan",
      statusValue: {
        pending: "Oczekuje na przegląd",
        approved: "Zatwierdzone",
        rejected: "Odrzucone",
        withdrawn: "Wycofane",
        superseded: "Zastąpione",
      },
      contentDigest: "Skrót treści",
      baseVersion: "Wersja bazowa",
      initialVersion: "Wersja początkowa",
      author: "Zgłaszający",
      reviewedBy: "Recenzent",
      policyVersion: "Wersja zasad",
      noSubmissions: "Brak zgłoszeń firmowych.",
      withdraw: "Wycofaj zgłoszenie",
      confirmWithdrawal: "Potwierdź wycofanie",
      withdrawalBoundary:
        "Wycofanie zamyka tylko to oczekujące zgłoszenie; lokalne szkice i dane Aera Runtime pozostają bez zmian.",
      draftReadOnly:
        "Ten szkic firmowy jest tylko do odczytu. Połącz się ponownie jako Właściciel lub Administrator, aby go zmienić.",
    },
    workspaceOfflineNotice:
      "Obszar roboczy jest offline. Zweryfikowane instalacje nadal działają lokalnie; szkice są tylko do odczytu, a publikowanie, wykrywanie, instalowanie i aktualizacje są wstrzymane.",
    view: "Wyświetl",
    workspaceDraftReadOnly:
      "Ten szkic jest offline tylko do odczytu. Połącz się ponownie, aby go zmienić lub opublikować.",
    errors: {
      workspace_forbidden:
        "Twoja obecna rola nie zezwala na tę operację agenta.",
      workspace_archived:
        "Ten obszar jest zarchiwizowany, a jego zasoby agentów są tylko do odczytu.",
      workspace_owner_unavailable:
        "Obszar pozostaje tylko do odczytu, dopóki konto właściciela nie będzie dostępne.",
    },
  },
} as const;
